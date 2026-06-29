import { pruneOldDevices } from "./storage/sqlite.js";

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const JITTER_MS = 60 * 60 * 1000; // ±1 hour

function scheduleNextPrune(): void {
  const delay = WEEK_MS + Math.floor((Math.random() * 2 - 1) * JITTER_MS);
  setTimeout(() => {
    runPrune();
    scheduleNextPrune();
  }, delay).unref(); // don't block process exit
}

function runPrune(): void {
  const retentionDays = parseInt(process.env.DEVICE_REGISTRY_RETENTION_DAYS ?? "90", 10);
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
  try {
    const removed = pruneOldDevices(cutoff);
    console.log(`[pruning] Removed ${removed} stale device record(s) older than ${retentionDays} days`);
  } catch (err) {
    console.error("[pruning] Failed to prune device registry:", err);
  }
}

export function startPruningJob(): void {
  scheduleNextPrune();
  console.log("[pruning] Weekly pruning job scheduled");
}
