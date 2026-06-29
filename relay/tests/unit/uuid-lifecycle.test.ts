/**
 * Step 15: UUID lifecycle unit tests.
 *
 * Exercises every edge in the state machine diagram from relay_data_model.md §5.
 * Uses a real Redis instance (REDIS_URL, default redis://localhost:6379).
 * Runs sequentially within the file; no parallelism.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import {
  getRedisClient,
  closeRedis,
  getUuid,
  setUuid,
  transitionUuid,
  isStoreEmpty,
  scanActiveUuids,
} from "../../src/utils/storage/redis.js";
import type { UuidRecord, UuidStatus } from "../../src/utils/storage/redis.js";

process.env.REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";

const TTL = 60;

function makeRecord(status: UuidStatus): UuidRecord {
  return {
    app_id: "test-app",
    push_token: "test-token",
    wallet_ws_url: "wss://wallet.example.com/ws",
    status,
    created_at: new Date().toISOString(),
  };
}

async function seed(uuid: string, status: UuidStatus): Promise<void> {
  await setUuid(uuid, makeRecord(status), TTL);
}

beforeAll(async () => {
  await getRedisClient().flushdb();
});

afterAll(async () => {
  await getRedisClient().flushdb();
  await closeRedis();
});

beforeEach(async () => {
  await getRedisClient().flushdb();
});

// ─── Valid transitions ────────────────────────────────────────────────────────

describe("Valid transitions", () => {
  it("unused → in_flight (push dispatch begins)", async () => {
    const uuid = crypto.randomUUID();
    await seed(uuid, "unused");
    const result = await transitionUuid(uuid, "unused", "in_flight");
    expect(result.ok).toBe(true);
    expect((await getUuid(uuid))?.status).toBe("in_flight");
  });

  it("in_flight → consumed (push dispatched successfully)", async () => {
    const uuid = crypto.randomUUID();
    await seed(uuid, "in_flight");
    const result = await transitionUuid(uuid, "in_flight", "consumed");
    expect(result.ok).toBe(true);
    expect((await getUuid(uuid))?.status).toBe("consumed");
  });

  it("in_flight → unused (push dispatch failed — UUID retryable)", async () => {
    const uuid = crypto.randomUUID();
    await seed(uuid, "in_flight");
    const result = await transitionUuid(uuid, "in_flight", "unused");
    expect(result.ok).toBe(true);
    expect((await getUuid(uuid))?.status).toBe("unused");
  });

  it("unused → active (WebSocket session opened)", async () => {
    const uuid = crypto.randomUUID();
    await seed(uuid, "unused");
    const result = await transitionUuid(uuid, "unused", "active");
    expect(result.ok).toBe(true);
    expect((await getUuid(uuid))?.status).toBe("active");
  });

  it("active → consumed (WebSocket session closed)", async () => {
    const uuid = crypto.randomUUID();
    await seed(uuid, "active");
    const result = await transitionUuid(uuid, "active", "consumed");
    expect(result.ok).toBe(true);
    expect((await getUuid(uuid))?.status).toBe("consumed");
  });

  it("full push path: unused → in_flight → consumed", async () => {
    const uuid = crypto.randomUUID();
    await seed(uuid, "unused");
    expect((await transitionUuid(uuid, "unused", "in_flight")).ok).toBe(true);
    expect((await transitionUuid(uuid, "in_flight", "consumed")).ok).toBe(true);
    expect((await getUuid(uuid))?.status).toBe("consumed");
  });

  it("full WebSocket path: unused → active → consumed", async () => {
    const uuid = crypto.randomUUID();
    await seed(uuid, "unused");
    expect((await transitionUuid(uuid, "unused", "active")).ok).toBe(true);
    expect((await transitionUuid(uuid, "active", "consumed")).ok).toBe(true);
    expect((await getUuid(uuid))?.status).toBe("consumed");
  });

  it("push retry path: unused → in_flight → unused (rollback)", async () => {
    const uuid = crypto.randomUUID();
    await seed(uuid, "unused");
    expect((await transitionUuid(uuid, "unused", "in_flight")).ok).toBe(true);
    expect((await transitionUuid(uuid, "in_flight", "unused")).ok).toBe(true);
    expect((await getUuid(uuid))?.status).toBe("unused");
  });
});

// ─── Invalid transitions ──────────────────────────────────────────────────────

describe("Invalid transitions", () => {
  it("consumed → any: returns WRONG_STATUS, state unchanged", async () => {
    for (const target of ["unused", "in_flight", "active", "consumed"] as UuidStatus[]) {
      const uuid = crypto.randomUUID();
      await seed(uuid, "consumed");
      const result = await transitionUuid(uuid, "consumed", target);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe("WRONG_STATUS");
      expect((await getUuid(uuid))?.status).toBe("consumed");
    }
  });

  it("active → any via wrong-from: returns WRONG_STATUS, state unchanged", async () => {
    // active → unused is not representable in the spec; calling notify on an active UUID
    // fails because the caller passes 'unused' as the expected from but current is 'active'.
    const uuid = crypto.randomUUID();
    await seed(uuid, "active");
    const result = await transitionUuid(uuid, "unused", "consumed");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("WRONG_STATUS");
      expect(result.currentStatus).toBe("active");
    }
    expect((await getUuid(uuid))?.status).toBe("active");
  });

  it("in_flight → any via wrong-from: returns WRONG_STATUS, state unchanged", async () => {
    const uuid = crypto.randomUUID();
    await seed(uuid, "in_flight");
    // Caller passes wrong expected-from ('unused'); current is 'in_flight' → rejected
    const result = await transitionUuid(uuid, "unused", "active");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("WRONG_STATUS");
      expect(result.currentStatus).toBe("in_flight");
    }
    expect((await getUuid(uuid))?.status).toBe("in_flight");
  });

  it("transition on unknown key: returns NOT_FOUND", async () => {
    const uuid = crypto.randomUUID(); // never seeded
    const result = await transitionUuid(uuid, "unused", "in_flight");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("NOT_FOUND");
  });

  it("getUuid on unknown key: returns null (does not throw)", async () => {
    const uuid = crypto.randomUUID();
    const record = await getUuid(uuid);
    expect(record).toBeNull();
  });
});

// ─── TTL expiry ───────────────────────────────────────────────────────────────

describe("TTL expiry", () => {
  it("UUID auto-expires after TTL and getUuid returns null", async () => {
    const uuid = crypto.randomUUID();
    await setUuid(uuid, makeRecord("unused"), 1); // 1 second TTL
    expect(await getUuid(uuid)).not.toBeNull();
    await new Promise<void>((r) => setTimeout(r, 1500));
    expect(await getUuid(uuid)).toBeNull();
  });

  it("expired UUID returns NOT_FOUND on transition attempt", async () => {
    const uuid = crypto.randomUUID();
    await setUuid(uuid, makeRecord("unused"), 1);
    await new Promise<void>((r) => setTimeout(r, 1500));
    const result = await transitionUuid(uuid, "unused", "in_flight");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("NOT_FOUND");
  });
});

// ─── Atomicity ────────────────────────────────────────────────────────────────

describe("Atomicity: concurrent transitions", () => {
  it("only one of two concurrent unused→in_flight transitions succeeds", async () => {
    const uuid = crypto.randomUUID();
    await seed(uuid, "unused");

    // Fire two concurrent transitions
    const [r1, r2] = await Promise.all([
      transitionUuid(uuid, "unused", "in_flight"),
      transitionUuid(uuid, "unused", "in_flight"),
    ]);

    const successCount = [r1, r2].filter((r) => r.ok).length;
    const failCount = [r1, r2].filter((r) => !r.ok).length;

    expect(successCount).toBe(1);
    expect(failCount).toBe(1);
    expect((await getUuid(uuid))?.status).toBe("in_flight");
  });

  it("only one of many concurrent unused→in_flight transitions succeeds", async () => {
    const uuid = crypto.randomUUID();
    await seed(uuid, "unused");

    const results = await Promise.all(
      Array.from({ length: 10 }, () => transitionUuid(uuid, "unused", "in_flight"))
    );

    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toHaveLength(9);
    expect((await getUuid(uuid))?.status).toBe("in_flight");
  });

  it("only one of two concurrent unused→active (WebSocket open) transitions succeeds", async () => {
    const uuid = crypto.randomUUID();
    await seed(uuid, "unused");

    const [r1, r2] = await Promise.all([
      transitionUuid(uuid, "unused", "active"),
      transitionUuid(uuid, "unused", "active"),
    ]);

    expect([r1, r2].filter((r) => r.ok)).toHaveLength(1);
    expect([r1, r2].filter((r) => !r.ok)).toHaveLength(1);
  });
});

// ─── Empty-store detection ────────────────────────────────────────────────────

describe("isStoreEmpty", () => {
  it("returns true when no uuid:* keys exist", async () => {
    expect(await isStoreEmpty()).toBe(true);
  });

  it("returns false after a UUID is seeded", async () => {
    const uuid = crypto.randomUUID();
    await seed(uuid, "unused");
    expect(await isStoreEmpty()).toBe(false);
  });

  it("returns true again after the UUID is deleted (simulating TTL expiry)", async () => {
    const uuid = crypto.randomUUID();
    await setUuid(uuid, makeRecord("unused"), 1);
    await new Promise<void>((r) => setTimeout(r, 1500));
    expect(await isStoreEmpty()).toBe(true);
  });
});

// ─── Startup scan ─────────────────────────────────────────────────────────────

describe("scanActiveUuids", () => {
  it("returns UUIDs in active or in_flight state, excludes unused and consumed", async () => {
    const active1 = crypto.randomUUID();
    const active2 = crypto.randomUUID();
    const inFlight = crypto.randomUUID();
    const unused = crypto.randomUUID();
    const consumed = crypto.randomUUID();

    await seed(active1, "active");
    await seed(active2, "active");
    await seed(inFlight, "in_flight");
    await seed(unused, "unused");
    await seed(consumed, "consumed");

    const stuck = await scanActiveUuids();

    expect(stuck).toContain(active1);
    expect(stuck).toContain(active2);
    expect(stuck).toContain(inFlight);
    expect(stuck).not.toContain(unused);
    expect(stuck).not.toContain(consumed);
  });

  it("returns empty array when no stuck UUIDs exist", async () => {
    await seed(crypto.randomUUID(), "unused");
    await seed(crypto.randomUUID(), "consumed");
    expect(await scanActiveUuids()).toHaveLength(0);
  });
});
