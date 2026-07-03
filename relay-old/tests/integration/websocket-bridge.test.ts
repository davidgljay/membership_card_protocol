/**
 * Integration tests for GET /ws/{uuid} WebSocket bridge.
 *
 * Requires a live Redis instance. Set REDIS_URL (default: redis://localhost:6379).
 * A stub wallet WebSocket server is spun up per test.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import http from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocketServer, WebSocket } from "ws";
import { router } from "../../src/router.js";
import { loadAppRegistry } from "../../src/utils/apps.js";
import { getRedisClient, closeRedis, setUuid } from "../../src/utils/storage/redis.js";
import { closeDb } from "../../src/utils/storage/sqlite.js";

process.env.NODE_ENV = "development";
process.env.REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";

let relayServer: http.Server;
let walletWss: WebSocketServer;
let walletServer: http.Server;
let relayBaseUrl: string;
let walletBaseUrl: string;
let tmpDir: string;

const TEST_APP_ID = "test-app";
const TTL = 300;

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "relay-ws-test-"));
  process.env.DB_PATH = join(tmpDir, "test.db");

  const fakeP8 = join(tmpDir, "fake.p8");
  writeFileSync(fakeP8, "-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----\n");

  // Wallet stub server — plain WS echo server
  walletServer = http.createServer();
  walletWss = new WebSocketServer({ server: walletServer });
  await new Promise<void>((r) => walletServer.listen(0, "127.0.0.1", r));
  const walletAddr = walletServer.address() as { port: number };
  walletBaseUrl = `ws://127.0.0.1:${walletAddr.port}`;

  const appsJson = join(tmpDir, "apps.json");
  writeFileSync(
    appsJson,
    JSON.stringify({
      apps: [
        {
          app_id: TEST_APP_ID,
          platform: "apns",
          wallet_ws_url: walletBaseUrl,
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
  await new Promise<void>((r) => walletServer.close(() => r()));
  await closeRedis();
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await getRedisClient().flushdb();
  // Remove all wallet listeners between tests
  walletWss.removeAllListeners("connection");
});

async function seedUuid(uuid: string): Promise<void> {
  await setUuid(uuid, {
    app_id: TEST_APP_ID,
    push_token: "test-token",
    wallet_ws_url: walletBaseUrl,
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

describe("GET /ws/{uuid} — connection establishment", () => {
  it("bridges device to wallet and passes messages device → wallet", async () => {
    const uuid = crypto.randomUUID();
    await seedUuid(uuid);

    const received: string[] = [];
    walletWss.on("connection", (ws: WebSocket) => {
      ws.on("message", (data: Buffer) => received.push(data.toString()));
    });

    const { ws: device } = await connectDevice(uuid);
    await new Promise<void>((r) => setTimeout(r, 50)); // let wallet connect
    device.send("hello from device");
    await new Promise<void>((r) => setTimeout(r, 100));

    expect(received).toContain("hello from device");
    device.close();
  });

  it("passes messages wallet → device", async () => {
    const uuid = crypto.randomUUID();
    await seedUuid(uuid);

    walletWss.on("connection", (ws: WebSocket) => {
      ws.on("open", () => ws.send("hello from wallet"));
      // send immediately on connection
      setTimeout(() => ws.send("hello from wallet"), 20);
    });

    const { ws: device, messages } = await connectDevice(uuid);
    await new Promise<void>((r) => setTimeout(r, 200));

    expect(messages).toContain("hello from wallet");
    device.close();
  });

  it("closes wallet socket when device disconnects and UUID becomes consumed", async () => {
    const uuid = crypto.randomUUID();
    await seedUuid(uuid);

    let walletClosed = false;
    walletWss.on("connection", (ws: WebSocket) => {
      ws.on("close", () => { walletClosed = true; });
    });

    const { ws: device } = await connectDevice(uuid);
    await new Promise<void>((r) => setTimeout(r, 50));
    device.close();
    await new Promise<void>((r) => setTimeout(r, 200));

    expect(walletClosed).toBe(true);

    const record = await getRedisClient().hget(`uuid:${uuid}`, "status");
    expect(record).toBe("consumed");
  });

  it("closes device connection when wallet disconnects and UUID becomes consumed", async () => {
    const uuid = crypto.randomUUID();
    await seedUuid(uuid);

    let walletSocket: WebSocket | null = null;
    walletWss.on("connection", (ws: WebSocket) => { walletSocket = ws; });

    const { ws: device } = await connectDevice(uuid);
    await new Promise<void>((r) => setTimeout(r, 100));

    const closedCode = waitForClose(device);
    walletSocket!.close();
    const code = await closedCode;
    expect(code).toBe(1001); // GOING_AWAY

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

    walletWss.on("connection", () => {}); // accept connections

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
      wallet_ws_url: walletBaseUrl,
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
      wallet_ws_url: walletBaseUrl,
      status: "consumed",
      created_at: new Date().toISOString(),
    }, TTL);

    const ws = new WebSocket(`${relayBaseUrl}/ws/${uuid}`);
    const code = await waitForClose(ws);
    expect(code).toBe(4010);
  });
});
