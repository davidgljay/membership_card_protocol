/**
 * Monitoring (notary_host.md §13). Alerts never contain job data: only a level, a stable code and integer counts.
 * The sanitizer is the single path to the webhook, so nothing else can leak into an alert.
 */
import type { Monitor } from "../services.js";

export const ALERT_CODES = ["enclaves_attested", "replicas_below_min_live", "anchor_backlog", "gas_balance_low", "snapshot_lag", "close_mismatch",
  "LIST_VERSION_REGRESSION", "key_exposed", "need_replica_failed", "enclave_lost", "storage_failure", "press_unreadable"] as const;

export function sanitizeAlert(level: string, code: string, counts: Record<string, number> = {}): { level: string; code: string; counts: Record<string, number> } {
  const safeCounts: Record<string, number> = {};
  for (const [k, v] of Object.entries(counts)) if (/^[a-z_]{1,40}$/.test(k) && Number.isInteger(v)) safeCounts[k] = v;
  return { level: ["info", "warn", "error"].includes(level) ? level : "error", code: /^[A-Za-z0-9_]{1,64}$/.test(code) ? code : "unknown", counts: safeCounts };
}

export function webhookMonitor(url: string | undefined, post: (url: string, body: unknown) => Promise<void>): Monitor {
  return {
    async alert(level, code, counts) {
      const a = sanitizeAlert(level, code, counts);
      if (url) await post(url, a).catch(() => undefined);
      // the sanitized alert also goes to the host's own log: level and code only, never job data
      else console.warn(`[notary-host] alert ${a.level} ${a.code}`);
    },
  };
}
