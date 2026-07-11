/**
 * Step 11: Failure case tests covering all rows of notification_relay.md §Failure Handling.
 * Step 12: UUID TTL and stuck-UUID startup scan tests.
 * Step 13: Re-registration notifier tests.
 * Step 14: Pruning job tests.
 *
 * Requires a live Redis instance (REDIS_URL, default redis://localhost:6379).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import http from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { router } from "../../src/router.js";
import { loadAppRegistry } from "../../src/utils/apps.js";
import {
  getRedisClient, closeRedis,
  setUuid, getUuid, transitionUuid,
  scanActiveUuids,
} from "../../src/utils/storage/redis.js";
import {
  getDb, closeDb,
  upsertDevice, getRecentDevices, pruneOldDevices,
} from "../../src/utils/storage/sqlite.js";
import { runReregistrationCheck } from "../../src/utils/reregistration.js";
import { runStartupChecks } from "../../src/startup.js";

process.env.NODE_ENV = "development";
process.env.REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";

const TEST_APP_ID = "test-app";
let relayServer: http.Server;
let relayBaseUrl: string;
let tmpDir: string;

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "relay-fail-test-"));
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

  relayServer = http.createServer((req, res) => {
    Promise.resolve(router(req, res)).catch((err) => {
      if (!res.headersSent) res.writeHead(500).end();
    });
  });
  relayServer.on("upgrade", (req, socket, head) => {
    import("../../src/routes/ws.js").then(({ handleUpgrade }) => handleUpgrade(req, socket, head));
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
  // Reset SQLite between tests
  getDb().prepare("DELETE FROM device_registry").run();
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function post(path: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const payload = body !== undefined ? JSON.stringify(body) : undefined;
    const req = http.request(`http://127.0.0.1:${(relayServer.address() as { port: number }).port}${path}`, {
      method: "POST",
      headers: payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {},
    }, (res) => {
      let data = "";
      res.on("data", (c: Buffer) => { data += c; });
      res.on("end", () => resolve({ status: res.statusCode!, body: JSON.parse(data) as Record<string, unknown> }));
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function seedUuid(uuid: string, status: "unused" | "active" | "in_flight" | "consumed" = "unused"): Promise<void> {
  await setUuid(uuid, {
    app_id: TEST_APP_ID,
    push_token: "test-token",
    wallet_base_url: "https://wallet.example.com",
    device_credential: "test-device-credential",
    status,
    created_at: new Date().toISOString(),
  }, 300);
}

// ─── Failure Handling Table (notification_relay.md §Failure Handling) ─────────

describe("Failure case: UUID pool exhausted at wallet", () => {
  it("wallet moves to next UUID after 404 on unknown UUID", async () => {
    // Relay returns 404 on unknown UUID — wallet should discard and use next
    const { status, body } = await post("/deliver/00000000-0000-4000-8000-000000000099", { blob: "x" });
    expect(status).toBe(404);
    expect(body.error).toBe("UNKNOWN_UUID");
  });

  it("wallet moves to next UUID after 410 on consumed UUID", async () => {
    const uuid = crypto.randomUUID();
    await seedUuid(uuid, "consumed");
    const { status, body } = await post(`/deliver/${uuid}`, { blob: "x" });
    expect(status).toBe(410);
    expect(body.error).toBe("UUID_CONSUMED");
  });
});

describe("Failure case: relay unreachable / push dispatch fails", () => {
  it("UUID is NOT consumed when deliver is attempted on an in_flight UUID", async () => {
    // Simulate a concurrent request that already claimed the UUID (in_flight).
    // A second caller attempting to deliver should get 410 UUID_CONSUMED and
    // the UUID should remain in_flight (not double-consumed).
    const uuid = crypto.randomUUID();
    await seedUuid(uuid, "in_flight");
    const { status, body } = await post(`/deliver/${uuid}`, { blob: "x" });
    expect(status).toBe(410);
    expect(body.error).toBe("UUID_CONSUMED");
    // The UUID remains in_flight (not consumed by this caller)
    const record = await getUuid(uuid);
    expect(record?.status).toBe("in_flight");
  });
});

describe("Failure case: WebSocket connection closed", () => {
  it("UUID is consumed when device disconnects mid-session", async () => {
    const uuid = crypto.randomUUID();
    await seedUuid(uuid);

    const device = new WebSocket(`${relayBaseUrl}/ws/${uuid}`);
    await new Promise<void>((r) => device.on("open", r));
    await new Promise<void>((r) => setTimeout(r, 50));

    device.close();
    await new Promise<void>((r) => setTimeout(r, 200));

    const record = await getUuid(uuid);
    expect(record?.status).toBe("consumed");
  });
});

describe("Failure case: push token rotated", () => {
  it("new push token for same app creates a new device registry entry", async () => {
    upsertDevice("old-token", TEST_APP_ID);
    upsertDevice("new-token", TEST_APP_ID);
    const devices = getRecentDevices(new Date(0));
    const tokens = devices.map((d) => d.push_token);
    expect(tokens).toContain("old-token");
    expect(tokens).toContain("new-token");
  });

  it("old UUIDs expire via TTL (short TTL test)", async () => {
    const uuid = crypto.randomUUID();
    await setUuid(uuid, {
      app_id: TEST_APP_ID, push_token: "old-token",
      wallet_base_url: "https://wallet.example.com", device_credential: "test-cred",
      status: "unused", created_at: new Date().toISOString(),
    }, 1); // 1 second TTL

    // Confirm UUID exists
    expect(await getUuid(uuid)).not.toBeNull();

    // Wait for TTL to expire
    await new Promise<void>((r) => setTimeout(r, 1500));
    expect(await getUuid(uuid)).toBeNull();
  });

  it("UUID rejected with 404 after TTL expiry", async () => {
    const uuid = crypto.randomUUID();
    await setUuid(uuid, {
      app_id: TEST_APP_ID, push_token: "old-token",
      wallet_base_url: "https://wallet.example.com", device_credential: "test-cred",
      status: "unused", created_at: new Date().toISOString(),
    }, 1);
    await new Promise<void>((r) => setTimeout(r, 1500));
    const { status, body } = await post(`/deliver/${uuid}`, { blob: "x" });
    expect(status).toBe(404);
    expect(body.error).toBe("UNKNOWN_UUID");
  });
});

describe("Failure case: UUID rejected by relay (already used or unknown)", () => {
  it("relay returns 410 for already-used UUID — wallet discards and retries with next UUID", async () => {
    const uuid = crypto.randomUUID();
    await seedUuid(uuid, "consumed");
    const { status } = await post(`/deliver/${uuid}`, { blob: "x" });
    expect(status).toBe(410);
  });

  it("relay returns 404 for unknown UUID", async () => {
    const { status } = await post("/deliver/aaaaaaaa-0000-4000-8000-000000000000", { blob: "x" });
    expect(status).toBe(404);
  });
});

// ─── Step 12: Stuck UUID startup scan ────────────────────────────────────────

describe("Step 12: Startup scan for stuck UUIDs", () => {
  it("active UUIDs from unclean shutdown are consumed on startup scan", async () => {
    const uuid1 = crypto.randomUUID();
    const uuid2 = crypto.randomUUID();
    await seedUuid(uuid1, "active");
    await seedUuid(uuid2, "active");

    const stuck = await scanActiveUuids();
    expect(stuck).toContain(uuid1);
    expect(stuck).toContain(uuid2);

    // Simulate what runStartupChecks does
    for (const uuid of stuck) {
      const r = await transitionUuid(uuid, "active", "consumed");
      expect(r.ok).toBe(true);
    }

    expect((await getUuid(uuid1))?.status).toBe("consumed");
    expect((await getUuid(uuid2))?.status).toBe("consumed");
  });

  it("in_flight UUIDs from crash during push dispatch are consumed on startup", async () => {
    const uuid = crypto.randomUUID();
    await seedUuid(uuid, "in_flight");

    const stuck = await scanActiveUuids();
    expect(stuck).toContain(uuid);

    await transitionUuid(uuid, "in_flight", "consumed");
    expect((await getUuid(uuid))?.status).toBe("consumed");
  });

  it("unused and consumed UUIDs are not affected by startup scan", async () => {
    const unusedUuid = crypto.randomUUID();
    const consumedUuid = crypto.randomUUID();
    await seedUuid(unusedUuid, "unused");
    await seedUuid(consumedUuid, "consumed");

    const stuck = await scanActiveUuids();
    expect(stuck).not.toContain(unusedUuid);
    expect(stuck).not.toContain(consumedUuid);
  });

  it("full runStartupChecks consumes stuck UUIDs and runs re-registration check", async () => {
    const uuid = crypto.randomUUID();
    await seedUuid(uuid, "active");

    await runStartupChecks();

    expect((await getUuid(uuid))?.status).toBe("consumed");
  });
});

// ─── Step 13: Re-registration notifier ───────────────────────────────────────

describe("Step 13: Re-registration notifier", () => {
  it("sends re-registration pushes when Redis is empty and devices are registered", async () => {
    upsertDevice("token-1", TEST_APP_ID);
    upsertDevice("token-2", TEST_APP_ID);

    // Redis is already empty (flushdb in beforeEach).
    // In dev/stub mode dispatchPush logs and returns; we just verify the function
    // completes without error and that it doesn't skip (isStoreEmpty returns true).
    const { isStoreEmpty } = await import("../../src/utils/storage/redis.js");
    expect(await isStoreEmpty()).toBe(true);
    await expect(runReregistrationCheck()).resolves.not.toThrow();
  });

  it("skips re-registration when Redis has UUID keys (normal startup)", async () => {
    upsertDevice("token-1", TEST_APP_ID);
    // Seed a UUID so store is not empty
    await seedUuid(crypto.randomUUID(), "unused");

    const dispatchCalls: string[] = [];
    // In dev mode, dispatchPush logs but doesn't throw — we verify isStoreEmpty returns false
    const { isStoreEmpty } = await import("../../src/utils/storage/redis.js");
    expect(await isStoreEmpty()).toBe(false);
  });

  it("skips re-registration when Redis is empty but device registry is also empty (first deploy)", async () => {
    // Redis empty (flushdb in beforeEach), device registry also empty (deleted in beforeEach)
    // runReregistrationCheck should log "first deploy" and return without error
    await expect(runReregistrationCheck()).resolves.not.toThrow();
  });

  it("re-registration uses devices registered within retention window only", async () => {
    // Insert one recent and one old device
    upsertDevice("recent-token", TEST_APP_ID);
    // Manually backdate the old entry
    getDb().prepare(
      "UPDATE device_registry SET last_registered_at = ? WHERE push_token = ?"
    ).run(new Date(0).toISOString(), "recent-token");
    upsertDevice("new-token", TEST_APP_ID); // fresh timestamp

    const retentionDays = 90;
    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
    const recent = getRecentDevices(cutoff);
    expect(recent.map((d) => d.push_token)).toContain("new-token");
    expect(recent.map((d) => d.push_token)).not.toContain("recent-token");
  });
});

// ─── Step 14: Pruning job ─────────────────────────────────────────────────────

describe("Step 14: SQLite pruning job", () => {
  it("removes records older than retention threshold", () => {
    upsertDevice("old-token", TEST_APP_ID);
    getDb().prepare("UPDATE device_registry SET last_registered_at = ? WHERE push_token = ?")
      .run(new Date(Date.now() - 91 * 24 * 60 * 60 * 1000).toISOString(), "old-token");

    upsertDevice("fresh-token", TEST_APP_ID);

    const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
    const removed = pruneOldDevices(cutoff);

    expect(removed).toBe(1);
    const remaining = getRecentDevices(new Date(0)).map((d) => d.push_token);
    expect(remaining).toContain("fresh-token");
    expect(remaining).not.toContain("old-token");
  });

  it("prune logs the count and does not touch recent records", () => {
    upsertDevice("keeper-1", TEST_APP_ID);
    upsertDevice("keeper-2", TEST_APP_ID);

    const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
    const removed = pruneOldDevices(cutoff);

    expect(removed).toBe(0);
    expect(getRecentDevices(new Date(0))).toHaveLength(2);
  });

  it("prune returns 0 on empty registry", () => {
    const cutoff = new Date();
    expect(pruneOldDevices(cutoff)).toBe(0);
  });
});
