/**
 * Integration tests for the message buffer endpoints:
 *   GET  /sse      — SSE stream (credential auth)
 *   GET  /pending  — drain message store
 *   POST /ack      — schedule staggered wallet deletes
 *
 * Also covers device credential authentication on all three endpoints.
 *
 * Requires a live Redis instance. Set REDIS_URL (default: redis://localhost:6379).
 * Push dispatch is replaced with a stub via NODE_ENV=development.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import http from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { router } from "../../src/router.js";
import { loadAppRegistry } from "../../src/utils/apps.js";
import { getRedisClient, closeRedis } from "../../src/utils/storage/redis.js";
import { closeDb } from "../../src/utils/storage/sqlite.js";

process.env.NODE_ENV = "development";
process.env.REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";
// Use a very short delete delay for tests that verify ack enqueue
process.env.MAX_DELETE_DELAY_SECONDS = "0";

let server: http.Server;
let baseUrl: string;
let tmpDir: string;

const TEST_APP_ID = "test-app";

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "relay-buffer-test-"));
  process.env.DB_PATH = join(tmpDir, "test.db");

  const fakeP8 = join(tmpDir, "fake.p8");
  writeFileSync(fakeP8, "-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----\n");

  const appsJson = join(tmpDir, "apps.json");
  writeFileSync(appsJson, JSON.stringify({
    apps: [{
      app_id: TEST_APP_ID,
      platform: "apns",
      wallet_base_url: "https://wallet.example.com",
      apns: { key_file: fakeP8, key_id: "AAAAAAAAAA", team_id: "BBBBBBBBBB", bundle_id: "com.test", sandbox: true },
    }],
  }));

  process.env.APP_REGISTRY_PATH = appsJson;
  loadAppRegistry(appsJson);

  await getRedisClient().flushdb();

  server = http.createServer((req, res) => {
    Promise.resolve(router(req, res)).catch((err) => {
      if (!res.headersSent) res.writeHead(500).end();
    });
  });

  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address() as { port: number };
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await closeRedis();
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await getRedisClient().flushdb();
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function request(
  method: string,
  path: string,
  body?: unknown,
  headers?: Record<string, string>
): Promise<{ status: number; body: unknown; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const payload = body !== undefined ? JSON.stringify(body) : undefined;
    const req = http.request(`${baseUrl}${path}`, {
      method,
      headers: {
        ...(payload ? { "Content-Type": "application/json", "Content-Length": String(Buffer.byteLength(payload)) } : {}),
        ...headers,
      },
    }, (res) => {
      let data = "";
      res.on("data", (c: Buffer) => { data += c; });
      res.on("end", () => {
        try { resolve({ status: res.statusCode!, body: JSON.parse(data), headers: res.headers }); }
        catch { resolve({ status: res.statusCode!, body: data, headers: res.headers }); }
      });
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function post(path: string, body?: unknown, headers?: Record<string, string>) {
  return request("POST", path, body, headers);
}
function get(path: string, headers?: Record<string, string>) {
  return request("GET", path, undefined, headers);
}

/** Bootstrap register, returns { uuids, device_credential } */
async function bootstrap(count = 1): Promise<{ uuids: string[]; device_credential: string }> {
  const { body } = await post("/register", { app_id: TEST_APP_ID, push_token: "token-abc", count });
  return body as { uuids: string[]; device_credential: string };
}

/** Deliver a blob to a UUID (wallet-side call) */
async function deliver(uuid: string, blob: string): Promise<void> {
  const { status } = await post(`/deliver/${uuid}`, { blob });
  if (status !== 200) throw new Error(`deliver failed with status ${status}`);
}

// ─── Credential authentication (shared across endpoints) ─────────────────────

describe("Credential authentication", () => {
  const authEndpoints = [
    { method: "GET",  path: "/sse",     body: undefined },
    { method: "GET",  path: "/pending", body: undefined },
    { method: "POST", path: "/ack",     body: { uuids: [] } },
  ];

  for (const { method, path, body } of authEndpoints) {
    it(`${method} ${path} — missing credential → 401 MISSING_CREDENTIAL`, async () => {
      const { status, body: respBody } = await request(method, path, body);
      // SSE holds open; for this test we just need the status code before stream begins
      expect(status).toBe(401);
      expect((respBody as { error: string }).error).toBe("MISSING_CREDENTIAL");
    });

    it(`${method} ${path} — invalid credential → 401 INVALID_CREDENTIAL`, async () => {
      const { status, body: respBody } = await request(
        method, path, body,
        { Authorization: "Bearer aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }
      );
      expect(status).toBe(401);
      expect((respBody as { error: string }).error).toBe("INVALID_CREDENTIAL");
    });
  }
});

// ─── GET /sse ─────────────────────────────────────────────────────────────────

describe("GET /sse", () => {
  it("opens with 200 and SSE content-type for valid credential", async () => {
    const { device_credential } = await bootstrap();

    // Open the SSE connection and immediately close it to avoid hanging the test
    await new Promise<void>((resolve, reject) => {
      const req = http.request(`${baseUrl}/sse`, {
        method: "GET",
        headers: { Authorization: `Bearer ${device_credential}` },
      }, (res) => {
        expect(res.statusCode).toBe(200);
        expect(res.headers["content-type"]).toContain("text/event-stream");
        req.destroy(); // close connection
        resolve();
      });
      req.on("error", (err) => {
        // ECONNRESET is expected after req.destroy()
        if ((err as NodeJS.ErrnoException).code === "ECONNRESET") resolve();
        else reject(err);
      });
      req.end();
    });
  });

  it("delivers a message over SSE when blob arrives after connection is open", async () => {
    const { uuids, device_credential } = await bootstrap();
    const [uuid] = uuids;
    const blob = "sse-test-blob";

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("SSE message not received in time")), 3000);

      const req = http.request(`${baseUrl}/sse`, {
        method: "GET",
        headers: { Authorization: `Bearer ${device_credential}` },
      }, (res) => {
        expect(res.statusCode).toBe(200);

        let buffer = "";
        res.on("data", (chunk: Buffer) => {
          buffer += chunk.toString();
          // Look for a data: line with our blob
          if (buffer.includes(`"blob":"${blob}"`)) {
            clearTimeout(timeout);
            req.destroy();
            resolve();
          }
        });
        res.on("error", (err) => {
          if ((err as NodeJS.ErrnoException).code !== "ECONNRESET") reject(err);
        });

        // Deliver the blob once the SSE connection is open
        setTimeout(() => {
          deliver(uuid, blob).catch(reject);
        }, 50);
      });

      req.on("error", (err) => {
        if ((err as NodeJS.ErrnoException).code !== "ECONNRESET") reject(err);
      });
      req.end();
    });
  });
});

// ─── GET /pending ─────────────────────────────────────────────────────────────

describe("GET /pending", () => {
  it("returns empty messages array when nothing is pending", async () => {
    const { device_credential } = await bootstrap();

    const { status, body } = await get("/pending", { Authorization: `Bearer ${device_credential}` });
    expect(status).toBe(200);
    expect((body as { messages: unknown[] }).messages).toHaveLength(0);
  });

  it("returns stored blobs and drains the store atomically", async () => {
    const { uuids, device_credential } = await bootstrap(3);
    const blobs = ["blob-1", "blob-2", "blob-3"];

    for (let i = 0; i < 3; i++) {
      await deliver(uuids[i], blobs[i]);
    }

    const { status, body } = await get("/pending", { Authorization: `Bearer ${device_credential}` });
    expect(status).toBe(200);

    const messages = (body as { messages: Array<{ uuid: string; blob: string }> }).messages;
    expect(messages).toHaveLength(3);

    const receivedBlobs = messages.map((m) => m.blob).sort();
    expect(receivedBlobs).toEqual(["blob-1", "blob-2", "blob-3"].sort());

    const receivedUuids = messages.map((m) => m.uuid).sort();
    expect(receivedUuids).toEqual([...uuids].sort());
  });

  it("second GET /pending returns empty after first drains the store", async () => {
    const { uuids, device_credential } = await bootstrap();
    await deliver(uuids[0], "some-blob");

    const first = await get("/pending", { Authorization: `Bearer ${device_credential}` });
    expect((first.body as { messages: unknown[] }).messages).toHaveLength(1);

    const second = await get("/pending", { Authorization: `Bearer ${device_credential}` });
    expect((second.body as { messages: unknown[] }).messages).toHaveLength(0);
  });

  it("only returns messages for the authenticated device credential", async () => {
    // Two separate devices
    const deviceA = await bootstrap(1);
    const deviceB = await bootstrap(1);

    await deliver(deviceA.uuids[0], "blob-for-A");
    await deliver(deviceB.uuids[0], "blob-for-B");

    const respA = await get("/pending", { Authorization: `Bearer ${deviceA.device_credential}` });
    const messagesA = (respA.body as { messages: Array<{ blob: string }> }).messages;
    expect(messagesA).toHaveLength(1);
    expect(messagesA[0].blob).toBe("blob-for-A");

    const respB = await get("/pending", { Authorization: `Bearer ${deviceB.device_credential}` });
    const messagesB = (respB.body as { messages: Array<{ blob: string }> }).messages;
    expect(messagesB).toHaveLength(1);
    expect(messagesB[0].blob).toBe("blob-for-B");
  });
});

// ─── POST /ack ────────────────────────────────────────────────────────────────

describe("POST /ack", () => {
  it("returns 200 for valid credential and existing UUIDs", async () => {
    const { uuids, device_credential } = await bootstrap(2);
    await deliver(uuids[0], "blob-0");
    await deliver(uuids[1], "blob-1");

    const { status } = await post(
      "/ack",
      { uuids },
      { Authorization: `Bearer ${device_credential}` }
    );
    expect(status).toBe(200);
  });

  it("enqueues delete jobs for acked UUIDs", async () => {
    const { uuids, device_credential } = await bootstrap(1);
    await deliver(uuids[0], "my-blob");

    await post("/ack", { uuids }, { Authorization: `Bearer ${device_credential}` });

    // With MAX_DELETE_DELAY_SECONDS=0, delete should be scheduled for now
    const { dequeuePendingDeletes } = await import("../../src/utils/storage/redis.js");
    const jobs = await dequeuePendingDeletes();
    expect(jobs.length).toBeGreaterThanOrEqual(1);
    expect(jobs.some((j) => j.uuid === uuids[0])).toBe(true);
  });

  it("returns 200 and silently skips expired/unknown UUIDs", async () => {
    const { device_credential } = await bootstrap();

    const { status } = await post(
      "/ack",
      { uuids: ["00000000-0000-4000-8000-000000000000"] },
      { Authorization: `Bearer ${device_credential}` }
    );
    expect(status).toBe(200);
  });

  it("returns 400 MISSING_FIELD when uuids array is absent", async () => {
    const { device_credential } = await bootstrap();

    const { status, body } = await post(
      "/ack",
      {},
      { Authorization: `Bearer ${device_credential}` }
    );
    expect(status).toBe(400);
    expect((body as { error: string }).error).toBe("MISSING_FIELD");
  });

  it("returns 400 MISSING_FIELD when uuids is an empty array", async () => {
    const { device_credential } = await bootstrap();

    const { status, body } = await post(
      "/ack",
      { uuids: [] },
      { Authorization: `Bearer ${device_credential}` }
    );
    expect(status).toBe(400);
    expect((body as { error: string }).error).toBe("MISSING_FIELD");
  });
});
