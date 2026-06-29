import { isStoreEmpty } from "./storage/redis.js";
import { getRecentDevices } from "./storage/sqlite.js";
import { getApp } from "./apps.js";
import { dispatchPush } from "./push/dispatch.js";

export async function runReregistrationCheck(): Promise<void> {
  // Stub — implemented in Phase 4 Step 13
  const empty = await isStoreEmpty();
  if (!empty) return;

  const retentionDays = parseInt(process.env.DEVICE_REGISTRY_RETENTION_DAYS ?? "90", 10);
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
  const devices = getRecentDevices(cutoff);

  if (devices.length === 0) {
    console.log("Redis store is empty but device registry is also empty — first deploy, skipping re-registration");
    return;
  }

  console.warn(`Redis store empty with ${devices.length} registered devices — sending re-registration notifications`);

  const relayId = process.env.RELAY_ID ?? "unknown";
  let sent = 0;
  let failed = 0;

  for (const device of devices) {
    const app = getApp(device.app_id);
    if (!app) {
      console.warn(`Unknown app_id ${device.app_id} for push_token ${device.push_token} — skipping`);
      failed++;
      continue;
    }
    try {
      await dispatchPush(device.push_token, null, app, {
        type: "relay_reregistration_requested",
        relay_id: relayId,
      });
      sent++;
    } catch (err) {
      console.warn(`Re-registration push failed for token ${device.push_token}:`, err);
      failed++;
    }
  }

  console.log(`Re-registration notifications: ${sent} sent, ${failed} failed`);
}
