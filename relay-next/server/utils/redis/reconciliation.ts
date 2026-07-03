// Reconciliation scan — relay_data_model.md §2.5 (stuck active/in_flight
// UUID scan) and §2.6 (empty-store detection with false-positive guard).
// Invoked by a Cloudflare Cron Trigger in production, or a local interval
// under node-server dev (Phase 2 step 2.6's trigger wiring applies here
// too — same "portable logic, platform-native trigger" split).

import type { RedisClient } from './resp-client';
import type { KVStorage } from '../kv/device-registry';
import { UUID_SCAN_PATTERN } from './keys';
import { UuidStore } from './uuid-store';

// KV key for the empty-store transition flag (relay_data_model.md §2.6:
// "store a single primary_db_was_empty boolean-equivalent flag as a
// Cloudflare KV entry ... same store as §5, distinct key"). This is NOT a
// UUID or device_credential — it is a single global boolean-equivalent
// flag, so storing it in KV does not violate the privacy invariant
// (relay_data_model.md §10.4 scopes the KV-write prohibition to UUID- and
// device_credential-linked data specifically).
const EMPTY_FLAG_KEY = 'meta:primary_db_was_empty';

export interface ReconciliationResult {
  stuckTransitioned: number;
  emptyStoreDetected: boolean;
  reregistrationTriggered: boolean;
}

export interface ReconciliationDeps {
  redis: RedisClient;
  kv: KVStorage;
  /** Called only when a genuine non-empty -> empty transition is detected (§2.6). */
  onStoreReset: () => Promise<void>;
  /** Injectable for tests; defaults to Date.now. */
  now?: () => number;
}

/**
 * Scans for stuck `active`/`in_flight` UUIDs and transitions them to
 * `consumed` (relay_data_model.md §2.5). Uses SCAN with a COUNT hint, not
 * KEYS *, per the spec's explicit instruction to avoid blocking Redis.
 */
export async function scanForStuckUuids(
  redis: RedisClient,
  scanCount = 100
): Promise<{ stuckCount: number; scannedKeys: number }> {
  const uuidStore = new UuidStore(redis);
  let cursor = '0';
  let stuckCount = 0;
  let scannedKeys = 0;

  do {
    const { cursor: nextCursor, keys } = await redis.scan(
      cursor,
      UUID_SCAN_PATTERN,
      scanCount
    );
    cursor = nextCursor;
    scannedKeys += keys.length;

    for (const key of keys) {
      const uuid = key.slice('uuid:'.length);
      const record = await uuidStore.get(uuid);
      if (!record) continue;
      if (record.status === 'active' || record.status === 'in_flight') {
        await uuidStore.forceConsumed(uuid);
        stuckCount += 1;
      }
    }
  } while (cursor !== '0');

  return { stuckCount, scannedKeys };
}

/**
 * Empty-store detection with the false-positive guard required by
 * relay_data_model.md §2.6: a momentarily-empty primary database (no
 * outstanding UUIDs right now) must NOT be confused with "the database was
 * reset." Only fires `onStoreReset` on the false -> true transition of the
 * `primary_db_was_empty` flag, and resets the flag to false as soon as any
 * UUID write succeeds again (that reset happens at UUID-creation time in
 * uuid-store.ts's `create`, which is a plain-write call site, not here —
 * see the note below).
 *
 * NOTE: resetting the flag on successful UUID writes is the register
 * handler's responsibility (it calls `clearEmptyFlag`, exported below),
 * not something this scan can do on its own, since this scan only runs
 * periodically and a write could happen at any time between scans.
 */
export async function detectEmptyStoreTransition(
  redis: RedisClient,
  kv: KVStorage
): Promise<{ isEmptyNow: boolean; transitionedToEmpty: boolean }> {
  const { cursor, keys } = await redis.scan('0', UUID_SCAN_PATTERN, 1);
  const isEmptyNow = cursor === '0' && keys.length === 0;

  const previousFlag = (await kv.getItem(EMPTY_FLAG_KEY)) as boolean | null;
  const wasEmpty = previousFlag === true;

  if (isEmptyNow && !wasEmpty) {
    // false -> true transition: this is the ONLY case that should trigger
    // re-registration (relay.md §9, relay_data_model.md §2.6).
    await kv.setItem(EMPTY_FLAG_KEY, true);
    return { isEmptyNow: true, transitionedToEmpty: true };
  }

  if (!isEmptyNow && wasEmpty) {
    // Recovered — clear the flag so a future empty reading can trigger
    // again if the store is genuinely reset a second time.
    await kv.setItem(EMPTY_FLAG_KEY, false);
  }

  return { isEmptyNow, transitionedToEmpty: false };
}

/** Called by the register handler after a successful UUID write (see note above). */
export async function clearEmptyFlag(kv: KVStorage): Promise<void> {
  await kv.setItem(EMPTY_FLAG_KEY, false);
}

/**
 * Full reconciliation pass — combines §2.5's stuck-UUID scan and §2.6's
 * empty-store detection into the single Cron-Trigger-invoked operation the
 * spec describes ("This check now runs as part of the same Cloudflare Cron
 * Trigger invocation as the stuck-UUID scan").
 */
export async function runReconciliation(
  deps: ReconciliationDeps
): Promise<ReconciliationResult> {
  const { stuckCount } = await scanForStuckUuids(deps.redis);
  const { transitionedToEmpty } = await detectEmptyStoreTransition(deps.redis, deps.kv);

  let reregistrationTriggered = false;
  if (transitionedToEmpty) {
    // §2.6 also requires confirming the KV device registry is non-empty
    // before firing re-registration (to avoid firing on a freshly-deployed,
    // never-yet-used relay where both stores are legitimately empty).
    const keys = await deps.kv.getKeys('registry:');
    if (keys.length > 0) {
      await deps.onStoreReset();
      reregistrationTriggered = true;
    }
  }

  return {
    stuckTransitioned: stuckCount,
    emptyStoreDetected: transitionedToEmpty,
    reregistrationTriggered,
  };
}
