import { scanActiveUuids, transitionUuid } from "./utils/storage/redis.js";
import { runReregistrationCheck } from "./utils/reregistration.js";
import { getDb } from "./utils/storage/sqlite.js";
import { startPruningJob } from "./utils/pruning.js";
import { startWalletClearance } from "./utils/wallet_clearance.js";

export async function runStartupChecks(): Promise<void> {
  // Ensure SQLite schema is created
  getDb();

  // Scan for UUIDs stuck in active or in_flight (unclean shutdown recovery)
  const stuckUuids = await scanActiveUuids();
  if (stuckUuids.length > 0) {
    console.warn(`[startup] Found ${stuckUuids.length} stuck UUID(s) from unclean shutdown — consuming`);
    for (const uuid of stuckUuids) {
      // Try active → consumed first, then in_flight → consumed
      const r1 = await transitionUuid(uuid, "active", "consumed");
      if (!r1.ok) {
        await transitionUuid(uuid, "in_flight", "consumed");
      }
    }
    console.warn(`[startup] Consumed ${stuckUuids.length} stuck UUID(s)`);
  } else {
    console.log("[startup] No stuck UUIDs found");
  }

  // Re-registration check (fires if Redis store is empty after a restart)
  await runReregistrationCheck();

  // Weekly SQLite pruning job
  startPruningJob();

  // Staggered wallet clearance background job
  startWalletClearance();
}
