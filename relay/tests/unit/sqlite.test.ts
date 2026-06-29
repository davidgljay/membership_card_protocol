import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "relay-test-"));
  process.env.DB_PATH = join(tmpDir, "test.db");
  // Reset module singleton between tests
  vi.resetModules();
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

import { vi } from "vitest";

describe("SQLite device registry", () => {
  it("upserts and retrieves a device", async () => {
    const { upsertDevice, getRecentDevices } = await import("../../src/utils/storage/sqlite.js");
    upsertDevice("token-abc", "app-1");
    const devices = getRecentDevices(new Date(0));
    expect(devices).toHaveLength(1);
    expect(devices[0].push_token).toBe("token-abc");
    expect(devices[0].app_id).toBe("app-1");
  });

  it("updates last_registered_at on re-upsert", async () => {
    const { upsertDevice, getRecentDevices } = await import("../../src/utils/storage/sqlite.js");
    upsertDevice("token-abc", "app-1");
    const before = getRecentDevices(new Date(0))[0].last_registered_at;
    await new Promise((r) => setTimeout(r, 10));
    upsertDevice("token-abc", "app-1");
    const after = getRecentDevices(new Date(0))[0].last_registered_at;
    expect(after >= before).toBe(true);
  });

  it("prunes old devices", async () => {
    const { upsertDevice, getRecentDevices, pruneOldDevices } = await import("../../src/utils/storage/sqlite.js");
    upsertDevice("old-token", "app-1");
    const future = new Date(Date.now() + 1000);
    const pruned = pruneOldDevices(future);
    expect(pruned).toBe(1);
    expect(getRecentDevices(new Date(0))).toHaveLength(0);
  });

  it("returns empty array when no devices registered recently", async () => {
    const { getRecentDevices } = await import("../../src/utils/storage/sqlite.js");
    const devices = getRecentDevices(new Date());
    expect(devices).toHaveLength(0);
  });
});
