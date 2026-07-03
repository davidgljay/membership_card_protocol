// Pending delete queue — relay_data_model.md §4. Staggered wallet-clearance
// jobs stored as a Redis sorted set, score = execute-at Unix timestamp.
// Ported against the spec directly. The background-job trigger (Cron
// Trigger vs. local interval) is wired in server/utils/delete-queue-job.ts
// (Phase 2 step 2.6) — this module is the portable Redis-operations layer
// only (decision #3: "business logic stays portable, only the trigger is
// platform-native").

import type { RedisClient } from './resp-client';
import { PENDING_DELETES_KEY } from './keys';

export interface DeleteJob {
  wallet_url: string;
  uuid: string;
  attempts: number;
}

export const DEFAULT_MAX_DELETE_DELAY_SECONDS = 21_600; // 6 hours, relay_data_model.md §9
const BASE_BACKOFF_SECONDS = 300; // 5 minutes, §4.2
const MAX_BACKOFF_SECONDS = 86_400; // 24 hours, §4.2

// Atomically dequeue all ready jobs (relay_data_model.md §4.2 "Dequeue ready jobs").
const DEQUEUE_READY_SCRIPT = `
local now = ARGV[1]
local jobs = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', now)
if #jobs > 0 then
  redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now)
end
return jobs
`;

export class DeleteQueue {
  constructor(
    private redis: RedisClient,
    private maxDelaySeconds: number = DEFAULT_MAX_DELETE_DELAY_SECONDS
  ) {}

  /** Enqueue on POST /ack (relay_data_model.md §4.2, relay.md §7.6). */
  async enqueue(walletUrl: string, uuid: string, nowUnixSeconds: number): Promise<void> {
    const executeAt = nowUnixSeconds + Math.floor(Math.random() * this.maxDelaySeconds);
    const job: DeleteJob = { wallet_url: walletUrl, uuid, attempts: 0 };
    await this.redis.zadd(PENDING_DELETES_KEY, executeAt, JSON.stringify(job));
  }

  /** Dequeue all jobs with score <= now, atomically (relay_data_model.md §4.2). */
  async dequeueReady(nowUnixSeconds: number): Promise<DeleteJob[]> {
    const result = await this.redis.eval(
      DEQUEUE_READY_SCRIPT,
      [PENDING_DELETES_KEY],
      [nowUnixSeconds]
    );
    if (!Array.isArray(result)) return [];
    return result.map((raw) => JSON.parse(raw as string) as DeleteJob);
  }

  /** Requeue on failure with exponential backoff (relay_data_model.md §4.2). */
  async requeueWithBackoff(job: DeleteJob, nowUnixSeconds: number): Promise<void> {
    const nextAttempts = job.attempts + 1;
    const backoff = Math.min(
      BASE_BACKOFF_SECONDS * 2 ** job.attempts,
      MAX_BACKOFF_SECONDS
    );
    const updated: DeleteJob = { ...job, attempts: nextAttempts };
    await this.redis.zadd(
      PENDING_DELETES_KEY,
      nowUnixSeconds + backoff,
      JSON.stringify(updated)
    );
  }
}
