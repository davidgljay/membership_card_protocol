/**
 * Integration tests for GET /ws/{uuid} WebSocket delivery (inbound-only).
 *
 * Requires a live Redis instance. Set REDIS_URL (default: redis://localhost:6379).
 * Tests the new inbound-only delivery model per relay.md §7.3.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import http from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { router } from "../../src/router.js";
import { loadAppRegistry } from "../../src/utils/apps.js";
import { getRedisClient, closeRedis, setUuid } from "../../src/utils/storage/redis.js";
import { closeDb } from "../../src/utils/storage/sqlite.js";

process.env.NODE_ENV = "development";
process.env.REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";

let relayServer: http.Server;
let relayBaseUrl: string;
let tmpDir: string;

const TEST_APP_ID = "test-app";
const TTL = 300;

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "relay-ws-test-"));
  process.env.DB_PATH = join(tmpDir, "test.db");

  const fakeP8 = join(tmpDir, "fake.p8");
  writeFileSync(fakeP8, "-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----\n");

  const appsJson = join(tmpDir, "apps.json");
  writeFileSync(
    appsJson,
    JSON.stringify({
      apps: [
        {
          app_id: TEST_APP_ID,
          platform: "apns",
          wallet_base_url: "https://wallet.example.com",
          apns: { key_file: fakeP8, key_id: "AAAAAAAAAA", team_id: "BBBBBBBBBB", bundle_id: "com.test.app", sandbox: true },
        },
      ],
    })
  );
  process.env.APP_REGISTRY_PATH = appsJson;
  loadAppRegistry(appsJson);

  await getRedisClient().flushdb();

  relayServer = http.createServer((req, res) => {
    Promise.resolve(router(req, res)).catch((err) => {
      console.error(err);
      if (!res.headersSent) res.writeHead(500).end();
    });
  });

  // Wire WebSocket upgrades
  relayServer.on("upgrade", (req, socket, head) => {
    import("../../src/routes/ws.js").then(({ handleUpgrade }) => {
      handleUpgrade(req, socket, head);
    });
  });

  await new Promise<void>((r) => relayServer.listen(0, "127.0.0.1", r));
  const relayAddr = relayServer.address() as { port: number };
  relayBaseUrl = `ws://127.0.0.1:${relayAddr.port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => relayServer.close(() => r()));
  await closeRedis();
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await getRedisClient().flushdb();
});

async function seedUuid(uuid: string, deviceCredential = "test-credential"): Promise<void> {
  await setUuid(uuid, {
    app_id: TEST_APP_ID,
    push_token: "test-token",
    wallet_base_url: "https://wallet.example.com",
    device_credential: deviceCredential,
    status: "unused",
    created_at: new Date().toISOString(),
  }, TTL);
}

function connectDevice(uuid: string): Promise<{ ws: WebSocket; messages: string[] }> {
  return new Promise((resolve, reject) => {
    const messages: string[] = [];
    const ws = new WebSocket(`${relayBaseUrl}/ws/${uuid}`);
    ws.on("open", () => resolve({ ws, messages }));
    ws.on("message", (data: Buffer) => { messages.push(data.toString()); });
    ws.on("error", reject);
  });
}

function waitForClose(ws: WebSocket): Promise<number> {
  return new Promise((resolve) => {
    ws.on("close", (code) => resolve(code));
  });
}

function postDeliver(uuid: string, blob: string): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ blob });
    const req = http.request(`http://127.0.0.1:${(relayServer.address() as { port: number }).port}/deliver/${uuid}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) },
    }, (res) => {
      let data = "";
      res.on("data", (c: Buffer) => { data += c; });
      res.on("end", () => resolve({ status: res.statusCode!, body: JSON.parse(data) }));
    });
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

describe("GET /ws/{uuid} — inbound-only delivery model", () => {
  it("accepts WebSocket connection for valid unused UUID and transitions to active", async () => {
    const uuid = crypto.randomUUID();
    await seedUuid(uuid);

    const { ws: device } = await connectDevice(uuid);
    await new Promise<void>((r) => setTimeout(r, 50));

    const record = await getRedisClient().hget(`uuid:${uuid}`, "status");
    expect(record).toBe("active");

    device.close();
  });

  it("delivers blob via POST /deliver to a *different* UUID sharing the same device_credential", async () => {
    // Per relay_data_model.md §8 / process_specs Process 3 step 6: the UUID
    // that opens GET /ws/{uuid} is consumed by opening the connection and is
    // never itself a valid POST /deliver/{uuid} target — the wallet always
    // delivers to a separate, still-unused UUID from the same device's pool.
    // The relay must find the open WebSocket by device_credential, not by
    // matching the delivery UUID against the connection's own UUID.
    const credential = "shared-credential-" + crypto.randomUUID();
    const wsUuid = crypto.randomUUID();
    const deliveryUuid = crypto.randomUUID();
    await seedUuid(wsUuid, credential);
    await seedUuid(deliveryUuid, credential);

    const { ws: device, messages } = await connectDevice(wsUuid);
    await new Promise<void>((r) => setTimeout(r, 50));

    // Deliver blob for the *other* UUID via HTTP POST (wallet-side call)
    const blob = "test-blob-base64url";
    const result = await postDeliver(deliveryUuid, blob);
    expect(result.status).toBe(200);

    // Wait for message to arrive over the open WebSocket
    await new Promise<void>((r) => {
      const timeout = setTimeout(r, 500);
      const interval = setInterval(() => {
        if (messages.length > 0) {
          clearTimeout(timeout);
          clearInterval(interval);
          r();
        }
      }, 10);
    });

    expect(messages).toHaveLength(1);
    const msg = JSON.parse(messages[0]);
    expect(msg.uuid).toBe(deliveryUuid);
    expect(msg.blob).toBe(blob);

    // The delivery UUID is consumed by the normal /deliver state machine;
    // the WS-opening UUID's own status is untouched by this delivery.
    const deliveryStatus = await getRedisClient().hget(`uuid:${deliveryUuid}`, "status");
    expect(deliveryStatus).toBe("consumed");
    const wsStatus = await getRedisClient().hget(`uuid:${wsUuid}`, "status");
    expect(wsStatus).toBe("active");

    device.close();
  });

  it("rejects POST /deliver called directly against a UUID that is itself open as a WebSocket", async () => {
    // An "active" UUID (i.e. currently open via GET /ws/{uuid}) is never a
    // valid /deliver target in its own right — see relay.md §7.2 step 3.
    const uuid = crypto.randomUUID();
    await seedUuid(uuid);

    const { ws: device } = await connectDevice(uuid);
    await new Promise<void>((r) => setTimeout(r, 50));

    const result = await postDeliver(uuid, "irrelevant-blob");
    expect(result.status).toBe(410);
    expect((result.body as { error: string }).error).toBe("UUID_CONSUMED");

    device.close();
  });

  it("ignores frames sent by device (delivery-only channel)", async () => {
    const uuid = crypto.randomUUID();
    await seedUuid(uuid);

    const { ws: device, messages } = await connectDevice(uuid);
    await new Promise<void>((r) => setTimeout(r, 50));

    // Device sends a frame — this should be ignored by relay, not forwarded
    device.send("device outbound message");
    await new Promise<void>((r) => setTimeout(r, 100));

    // No message should arrive (relay ignores device frames)
    expect(messages).toHaveLength(0);

    device.close();
  });

  it("transitions UUID to consumed when device closes", async () => {
    const uuid = crypto.randomUUID();
    await seedUuid(uuid);

    const { ws: device } = await connectDevice(uuid);
    await new Promise<void>((r) => setTimeout(r, 50));

    device.close();
    await new Promise<void>((r) => setTimeout(r, 100));

    const record = await getRedisClient().hget(`uuid:${uuid}`, "status");
    expect(record).toBe("consumed");
  });

  it("transitions UUID to consumed when device has network error", async () => {
    const uuid = crypto.randomUUID();
    await seedUuid(uuid);

    const { ws: device } = await connectDevice(uuid);
    await new Promise<void>((r) => setTimeout(r, 50));

    // Simulate network error by destroying the socket
    (device as unknown as { _socket?: { destroy(): void } })._socket?.destroy();
    await new Promise<void>((r) => setTimeout(r, 100));

    const record = await getRedisClient().hget(`uuid:${uuid}`, "status");
    expect(record).toBe("consumed");
  });
});

describe("GET /ws/{uuid} — rejection cases", () => {
  it("rejects with 4000 for invalid UUID format", async () => {
    const ws = new WebSocket(`${relayBaseUrl}/ws/not-a-uuid`);
    const code = await waitForClose(ws);
    expect(code).toBe(4000);
  });

  it("rejects with 4004 for unknown UUID", async () => {
    const ws = new WebSocket(`${relayBaseUrl}/ws/00000000-0000-4000-8000-000000000001`);
    const code = await waitForClose(ws);
    expect(code).toBe(4004);
  });

  it("rejects second connection to same UUID with 4010", async () => {
    const uuid = crypto.randomUUID();
    await seedUuid(uuid);

    const { ws: first } = await connectDevice(uuid);
    await new Promise<void>((r) => setTimeout(r, 50));

    const second = new WebSocket(`${relayBaseUrl}/ws/${uuid}`);
    const code = await waitForClose(second);
    expect(code).toBe(4010); // UUID_CONSUMED (now active)

    first.close();
  });

  it("rejects connection to a consumed UUID with 4010", async () => {
    const uuid = crypto.randomUUID();
    await setUuid(uuid, {
      app_id: TEST_APP_ID,
      push_token: "test-token",
      wallet_base_url: "https://wallet.example.com",
      status: "consumed",
      created_at: new Date().toISOString(),
    }, TTL);

    const ws = new WebSocket(`${relayBaseUrl}/ws/${uuid}`);
    const code = await waitForClose(ws);
    expect(code).toBe(4010);
  });

  it("rejects connection to a push-consumed UUID with 4010", async () => {
    const uuid = crypto.randomUUID();
    await setUuid(uuid, {
      app_id: TEST_APP_ID,
      push_token: "test-token",
      wallet_base_url: "https://wallet.example.com",
      status: "consumed",
      created_at: new Date().toISOString(),
    }, TTL);

    const ws = new WebSocket(`${relayBaseUrl}/ws/${uuid}`);
    const code = await waitForClose(ws);
    expect(code).toBe(4010);
  });
});
