/**
 * Integration tests for POST /register and POST /deliver/{uuid}.
 *
 * Requires a live Redis instance. Set REDIS_URL (default: redis://localhost:6379).
 * Push dispatch is replaced with a stub via NODE_ENV=development.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { router } from "../../src/router.js";
import { loadAppRegistry } from "../../src/utils/apps.js";
import { getRedisClient, closeRedis } from "../../src/utils/storage/redis.js";
import { closeDb } from "../../src/utils/storage/sqlite.js";

// Force stub push mode
process.env.NODE_ENV = "development";
process.env.REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";

let server: http.Server;
let baseUrl: string;
let tmpDir: string;

const TEST_APP_ID = "test-app";

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "relay-int-test-"));
  process.env.DB_PATH = join(tmpDir, "test.db");

  const appsJson = join(tmpDir, "apps.json");
  const fs = await import("node:fs");
  fs.writeFileSync(
    appsJson,
    JSON.stringify({
      apps: [
        {
          app_id: TEST_APP_ID,
          platform: "apns",
          wallet_ws_url: "wss://wallet.example.com/ws",
          apns: {
            key_file: join(tmpDir, "fake.p8"),
            key_id: "AAAAAAAAAA",
            team_id: "BBBBBBBBBB",
            bundle_id: "com.test.app",
            sandbox: true,
          },
        },
      ],
    })
  );
  fs.writeFileSync(join(tmpDir, "fake.p8"), "-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----\n");

  process.env.APP_REGISTRY_PATH = appsJson;
  loadAppRegistry(appsJson);

  await getRedisClient().flushdb();

  server = http.createServer((req, res) => {
    Promise.resolve(router(req, res)).catch((err) => {
      console.error(err);
      if (!res.headersSent) res.writeHead(500).end();
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as { port: number };
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve()))
  );
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
): Promise<{ status: number; body: unknown }> {
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
        try { resolve({ status: res.statusCode!, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode!, body: data }); }
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

// Performs bootstrap registration, returns { uuids, device_credential }
async function bootstrap(count = 1): Promise<{ uuids: string[]; device_credential: string }> {
  const { body } = await post("/register", { app_id: TEST_APP_ID, push_token: "token-abc", count });
  return body as { uuids: string[]; device_credential: string };
}

// ─── POST /register (bootstrap) ──────────────────────────────────────────────

describe("POST /register — bootstrap (no Authorization header)", () => {
  it("returns 10 UUIDs and a device_credential by default", async () => {
    const { status, body } = await post("/register", { app_id: TEST_APP_ID, push_token: "token-abc" });
    const b = body as { uuids: string[]; device_credential: string };
    expect(status).toBe(200);
    expect(b.uuids).toHaveLength(10);
    expect(typeof b.device_credential).toBe("string");
    expect(b.device_credential).toHaveLength(64); // 32 bytes hex
  });

  it("returns count UUIDs when count is specified", async () => {
    const { status, body } = await post("/register", { app_id: TEST_APP_ID, push_token: "token-abc", count: 20 });
    const b = body as { uuids: string[] };
    expect(status).toBe(200);
    expect(b.uuids).toHaveLength(20);
  });

  it("returns 400 MISSING_FIELD when app_id is absent", async () => {
    const { status, body } = await post("/register", { push_token: "token-abc" });
    expect(status).toBe(400);
    expect((body as { error: string }).error).toBe("MISSING_FIELD");
  });

  it("returns 400 MISSING_FIELD when push_token is absent", async () => {
    const { status, body } = await post("/register", { app_id: TEST_APP_ID });
    expect(status).toBe(400);
    expect((body as { error: string }).error).toBe("MISSING_FIELD");
  });

  it("returns 400 INVALID_COUNT when count is out of range", async () => {
    const { status, body } = await post("/register", { app_id: TEST_APP_ID, push_token: "token-abc", count: 101 });
    expect(status).toBe(400);
    expect((body as { error: string }).error).toBe("INVALID_COUNT");
  });

  it("returns 400 INVALID_COUNT when count is 0", async () => {
    const { status, body } = await post("/register", { app_id: TEST_APP_ID, push_token: "token-abc", count: 0 });
    expect(status).toBe(400);
    expect((body as { error: string }).error).toBe("INVALID_COUNT");
  });

  it("returns 404 UNKNOWN_APP for unrecognized app_id", async () => {
    const { status, body } = await post("/register", { app_id: "no-such-app", push_token: "token-abc" });
    expect(status).toBe(404);
    expect((body as { error: string }).error).toBe("UNKNOWN_APP");
  });
});

// ─── POST /register (replenishment) ──────────────────────────────────────────

describe("POST /register — replenishment (with Authorization header)", () => {
  it("returns new UUIDs but NO device_credential on replenishment", async () => {
    const { device_credential } = await bootstrap();

    const { status, body } = await post(
      "/register",
      { app_id: TEST_APP_ID, push_token: "token-abc", count: 5 },
      { Authorization: `Bearer ${device_credential}` }
    );
    const b = body as Record<string, unknown>;
    expect(status).toBe(200);
    expect(Array.isArray(b.uuids)).toBe(true);
    expect((b.uuids as string[]).length).toBe(5);
    expect(b.device_credential).toBeUndefined();
  });

  it("returns 401 INVALID_CREDENTIAL for an unknown credential", async () => {
    const { status, body } = await post(
      "/register",
      { app_id: TEST_APP_ID, push_token: "token-abc" },
      { Authorization: "Bearer aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }
    );
    expect(status).toBe(401);
    expect((body as { error: string }).error).toBe("INVALID_CREDENTIAL");
  });

  it("UUIDs from replenishment share the same device_credential", async () => {
    const { device_credential: cred, uuids: firstUuids } = await bootstrap(1);

    const { body } = await post(
      "/register",
      { app_id: TEST_APP_ID, push_token: "token-abc", count: 1 },
      { Authorization: `Bearer ${cred}` }
    );
    const secondUuids = (body as { uuids: string[] }).uuids;

    // Verify UUID records in Redis carry the same credential
    const { getUuid } = await import("../../src/utils/storage/redis.js");
    const firstRecord = await getUuid(firstUuids[0]);
    const secondRecord = await getUuid(secondUuids[0]);

    expect(firstRecord?.device_credential).toBe(cred);
    expect(secondRecord?.device_credential).toBe(cred);
  });
});

// ─── POST /deliver/{uuid} ─────────────────────────────────────────────────────

describe("POST /deliver/{uuid}", () => {
  it("returns 200 and UUID is consumed after successful deliver", async () => {
    const { uuids } = await bootstrap();
    const [uuid] = uuids;

    const { status } = await post(`/deliver/${uuid}`, { blob: "encrypted-payload-base64" });
    expect(status).toBe(200);

    // Second call: UUID is now consumed
    const second = await post(`/deliver/${uuid}`, { blob: "another-blob" });
    expect(second.status).toBe(410);
    expect((second.body as { error: string }).error).toBe("UUID_CONSUMED");
  });

  it("returns 400 MISSING_FIELD when blob is absent", async () => {
    const { uuids } = await bootstrap();
    const [uuid] = uuids;

    const { status, body } = await post(`/deliver/${uuid}`, {});
    expect(status).toBe(400);
    expect((body as { error: string }).error).toBe("MISSING_FIELD");
  });

  it("returns 400 MISSING_FIELD when body is not JSON", async () => {
    const { uuids } = await bootstrap();
    const [uuid] = uuids;

    const { status, body } = await new Promise<{ status: number; body: unknown }>((resolve, reject) => {
      const payload = "not-json";
      const req = http.request(`${baseUrl}/deliver/${uuid}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": String(Buffer.byteLength(payload)) },
      }, (res) => {
        let data = "";
        res.on("data", (c: Buffer) => { data += c; });
        res.on("end", () => {
          try { resolve({ status: res.statusCode!, body: JSON.parse(data) }); }
          catch { resolve({ status: res.statusCode!, body: data }); }
        });
      });
      req.on("error", reject);
      req.write(payload);
      req.end();
    });
    expect(status).toBe(400);
    expect((body as { error: string }).error).toBe("MISSING_FIELD");
  });

  it("returns 404 UNKNOWN_UUID for a random unknown UUID", async () => {
    const { status, body } = await post("/deliver/00000000-0000-4000-8000-000000000000", { blob: "x" });
    expect(status).toBe(404);
    expect((body as { error: string }).error).toBe("UNKNOWN_UUID");
  });

  it("returns 400 INVALID_UUID for a malformed UUID", async () => {
    const { status, body } = await post("/deliver/not-a-uuid", { blob: "x" });
    expect(status).toBe(400);
    expect((body as { error: string }).error).toBe("INVALID_UUID");
  });

  it("returns 410 UUID_CONSUMED on second deliver attempt", async () => {
    const { uuids } = await bootstrap();
    const [uuid] = uuids;

    await post(`/deliver/${uuid}`, { blob: "first" });
    const { status, body } = await post(`/deliver/${uuid}`, { blob: "second" });
    expect(status).toBe(410);
    expect((body as { error: string }).error).toBe("UUID_CONSUMED");
  });

  it("stores blob in message store (retrievable via GET /pending)", async () => {
    const { uuids, device_credential } = await bootstrap();
    const [uuid] = uuids;
    const blob = "my-encrypted-blob";

    await post(`/deliver/${uuid}`, { blob });

    // Drain the message store directly
    const { drainMessages } = await import("../../src/utils/storage/redis.js");
    const messages = await drainMessages(device_credential);
    expect(messages).toHaveLength(1);
    expect(messages[0].uuid).toBe(uuid);
    expect(messages[0].blob).toBe(blob);
  });
});

// ─── POST /notify/{uuid} — deprecated ────────────────────────────────────────

describe("POST /notify/{uuid} — deprecated endpoint", () => {
  it("returns 410 ENDPOINT_DEPRECATED", async () => {
    const { uuids } = await bootstrap();
    const [uuid] = uuids;

    const { status, body } = await post(`/notify/${uuid}`);
    expect(status).toBe(410);
    expect((body as { error: string }).error).toBe("ENDPOINT_DEPRECATED");
  });

  it("returns 410 for unknown UUID too (deprecated check takes priority)", async () => {
    const { status, body } = await post("/notify/00000000-0000-4000-8000-000000000000");
    expect(status).toBe(410);
    expect((body as { error: string }).error).toBe("ENDPOINT_DEPRECATED");
  });
});
