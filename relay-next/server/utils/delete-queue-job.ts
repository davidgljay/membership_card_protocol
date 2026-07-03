// Delete-queue background job — relay_data_model.md §4.4. Portable
// Redis-operations business logic (decision #3: "business logic stays
// Redis-based and portable... the trigger is necessarily platform-native").
// This module is the portable part; the trigger wiring lives in:
//   - server/routes/__scheduled.ts (Cloudflare Cron Trigger handler)
//   - server/plugins/dev-scheduler.ts (node-server local interval)
//
// Also runs the reconciliation scan (relay_data_model.md §2.5-§2.6) in the
// same invocation — the spec explicitly says both jobs "share their
// trigger" (§4.4).

import { DeleteQueue, type DeleteJob } from './redis/delete-queue';
import type { RedisClient } from './redis/resp-client';
import { runReconciliation, type ReconciliationResult } from './redis/reconciliation';
import type { KVStorage } from './kv/device-registry';

export interface DeleteQueueJobResult {
  processed: number;
  succeeded: number;
  failed: number;
  requeued: number;
}

export interface WalletDeleteClient {
  /** DELETE {wallet_url}/messages/{uuid} — relay_data_model.md §4.2 step 2. */
  deleteMessage(walletUrl: string, uuid: string): Promise<{ status: number }>;
}

export const defaultWalletDeleteClient: WalletDeleteClient = {
  async deleteMessage(walletUrl: string, uuid: string) {
    try {
      const res = await fetch(`${walletUrl}/messages/${uuid}`, { method: 'DELETE' });
      return { status: res.status };
    } catch {
      // Network error/timeout — treated as a 5xx-equivalent failure by the
      // caller below (relay_data_model.md §4.4 step 4).
      return { status: 599 };
    }
  },
};

/**
 * Processes all currently-ready delete jobs (relay_data_model.md §4.4
 * steps 1-4). Each invocation runs to completion or the platform's
 * execution-time limit; an interruption mid-batch simply leaves remaining
 * jobs for the next scheduled invocation (§4.4's "No shutdown-flush
 * equivalent" note) — this function does not need to handle interruption
 * specially, since jobs are dequeued (removed from the queue) before
 * processing and only ever re-added on explicit failure.
 */
export async function runDeleteQueueJob(
  redis: RedisClient,
  walletClient: WalletDeleteClient = defaultWalletDeleteClient,
  nowUnixSeconds: number = Math.floor(Date.now() / 1000)
): Promise<DeleteQueueJobResult> {
  const queue = new DeleteQueue(redis);
  const jobs = await queue.dequeueReady(nowUnixSeconds);

  let succeeded = 0;
  let failed = 0;
  let requeued = 0;

  for (const job of jobs) {
    const { status } = await walletClient.deleteMessage(job.wallet_url, job.uuid);
    if ((status >= 200 && status < 300) || status === 404) {
      // relay_data_model.md §4.4 step 3: "On success (2xx) or 404: discard the job."
      succeeded += 1;
    } else {
      // §4.4 step 4: "On failure (5xx, timeout, network error): requeue
      // with exponential backoff."
      await queue.requeueWithBackoff(job as DeleteJob, nowUnixSeconds);
      failed += 1;
      requeued += 1;
    }
  }

  return { processed: jobs.length, succeeded, failed, requeued };
}

export interface ScheduledInvocationResult {
  deleteQueue: DeleteQueueJobResult;
  reconciliation: ReconciliationResult;
}

/**
 * The single combined operation a Cron Trigger (prod) or local interval
 * (node-server dev) invokes — delete-queue processing + reconciliation
 * scan, since the spec says they share a trigger (§2.5, §4.4).
 */
export async function runScheduledInvocation(
  redis: RedisClient,
  kv: KVStorage,
  onStoreReset: () => Promise<void>,
  walletClient: WalletDeleteClient = defaultWalletDeleteClient
): Promise<ScheduledInvocationResult> {
  const deleteQueueResult = await runDeleteQueueJob(redis, walletClient);
  const reconciliationResult = await runReconciliation({ redis, kv, onStoreReset });
  return { deleteQueue: deleteQueueResult, reconciliation: reconciliationResult };
}
