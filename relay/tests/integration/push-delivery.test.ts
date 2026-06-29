/**
 * Integration tests for POST /register → POST /notify/{uuid} path.
 *
 * Requires a live Redis instance. Set REDIS_URL (default: redis://localhost:6379).
 * Push dispatch is replaced with a stub via NODE_ENV=test (same stub path as development).
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

  // Write a minimal apps.json without credential file checks
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
  // Create a dummy p8 file so validation passes
  fs.writeFileSync(join(tmpDir, "fake.p8"), "-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----\n");

  process.env.APP_REGISTRY_PATH = appsJson;
  loadAppRegistry(appsJson);

  // Flush test keys in Redis before starting
  const redis = getRedisClient();
  await redis.flushdb();

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

async function post(path: string, body?: unknown): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const payload = body !== undefined ? JSON.stringify(body) : undefined;
    const req = http.request(`${baseUrl}${path}`, {
      method: "POST",
      headers: payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {},
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

describe("POST /register", () => {
  it("returns 10 UUIDs by default", async () => {
    const { status, body } = await post("/register", { app_id: TEST_APP_ID, push_token: "token-abc" });
    expect(status).toBe(200);
    expect((body as { uuids: string[] }).uuids).toHaveLength(10);
  });

  it("returns count UUIDs when count is specified", async () => {
    const { status, body } = await post("/register", { app_id: TEST_APP_ID, push_token: "token-abc", count: 20 });
    expect(status).toBe(200);
    expect((body as { uuids: string[] }).uuids).toHaveLength(20);
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

describe("POST /notify/{uuid}", () => {
  async function register(count = 1): Promise<string[]> {
    const { body } = await post("/register", { app_id: TEST_APP_ID, push_token: "token-abc", count });
    return (body as { uuids: string[] }).uuids;
  }

  it("returns 200 and UUID is consumed after successful notify", async () => {
    const [uuid] = await register();
    const { status } = await post(`/notify/${uuid}`);
    expect(status).toBe(200);

    // Second call: UUID is now consumed
    const second = await post(`/notify/${uuid}`);
    expect(second.status).toBe(410);
    expect((second.body as { error: string }).error).toBe("UUID_CONSUMED");
  });

  it("returns 404 UNKNOWN_UUID for a random unknown UUID", async () => {
    const { status, body } = await post("/notify/00000000-0000-4000-8000-000000000000");
    expect(status).toBe(404);
    expect((body as { error: string }).error).toBe("UNKNOWN_UUID");
  });

  it("returns 400 INVALID_UUID for a malformed UUID", async () => {
    const { status, body } = await post("/notify/not-a-uuid");
    expect(status).toBe(400);
    expect((body as { error: string }).error).toBe("INVALID_UUID");
  });

  it("returns 410 UUID_CONSUMED on second notify attempt", async () => {
    const [uuid] = await register();
    await post(`/notify/${uuid}`);
    const { status, body } = await post(`/notify/${uuid}`);
    expect(status).toBe(410);
    expect((body as { error: string }).error).toBe("UUID_CONSUMED");
  });
});
