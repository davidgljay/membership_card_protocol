import { dequeuePendingDeletes, requeuePendingDelete } from "./storage/redis.js";
import type { DeleteJob } from "./storage/redis.js";

const POLL_INTERVAL_MS = parseInt(process.env.DELETE_JOB_POLL_INTERVAL_MS ?? "60000", 10);
const BASE_BACKOFF_MS = 300_000; // 5 minutes
const MAX_BACKOFF_MS = 86_400_000; // 24 hours

let pollTimer: NodeJS.Timeout | null = null;
let running = false;

async function executeDelete(job: DeleteJob): Promise<void> {
  const url = `${job.wallet_url}/messages/${job.uuid}`;
  const response = await fetch(url, { method: "DELETE" });

  if (response.ok || response.status === 404) {
    // 404 means the wallet already cleared the message — treat as success
    return;
  }

  // Any other status is a failure — requeue with backoff
  const backoffMs = Math.min(BASE_BACKOFF_MS * Math.pow(2, job.attempts), MAX_BACKOFF_MS);
  const executeAtMs = Date.now() + backoffMs;
  const updatedJob: DeleteJob = { ...job, attempts: job.attempts + 1 };

  await requeuePendingDelete(updatedJob, executeAtMs);
  console.warn(
    `Wallet delete failed for UUID ${job.uuid} (status ${response.status}). ` +
    `Attempt ${updatedJob.attempts}, requeued in ${Math.round(backoffMs / 1000)}s`
  );
}

async function poll(): Promise<void> {
  let jobs: DeleteJob[];
  try {
    jobs = await dequeuePendingDeletes();
  } catch (err) {
    console.error("Failed to dequeue pending deletes:", err);
    return;
  }

  if (jobs.length === 0) return;

  await Promise.allSettled(
    jobs.map((job) =>
      executeDelete(job).catch((err) => {
        console.error(`Unexpected error executing delete for UUID ${job.uuid}:`, err);
        // Requeue on unexpected error (network failure, etc.)
        const backoffMs = Math.min(BASE_BACKOFF_MS * Math.pow(2, job.attempts), MAX_BACKOFF_MS);
        return requeuePendingDelete(
          { ...job, attempts: job.attempts + 1 },
          Date.now() + backoffMs
        ).catch((e) => console.error("Failed to requeue after unexpected error:", e));
      })
    )
  );
}

export function startWalletClearance(): void {
  if (running) return;
  running = true;
  pollTimer = setInterval(() => {
    poll().catch((err) => console.error("Wallet clearance poll error:", err));
  }, POLL_INTERVAL_MS);
  console.log(`Wallet clearance job started (interval: ${POLL_INTERVAL_MS}ms)`);
}

export async function stopWalletClearance(timeoutMs = 5000): Promise<void> {
  if (!running) return;
  running = false;

  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }

  // Final flush: execute any jobs that are due right now
  const deadline = Date.now() + timeoutMs;
  try {
    const jobs = await dequeuePendingDeletes();
    const remaining = deadline - Date.now();
    if (jobs.length > 0 && remaining > 0) {
      await Promise.race([
        Promise.allSettled(jobs.map((job) => executeDelete(job))),
        new Promise<void>((resolve) => setTimeout(resolve, remaining)),
      ]);
    }
  } catch (err) {
    console.error("Error during wallet clearance shutdown flush:", err);
  }

  console.log("Wallet clearance job stopped");
}
