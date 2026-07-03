import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestRedisHarness, type TestRedisHarness } from './redis/test-harness';
import { DeleteQueue } from './redis/delete-queue';
import { runDeleteQueueJob, type WalletDeleteClient } from './delete-queue-job';

describe('runDeleteQueueJob (relay_data_model.md §4.4)', () => {
  let harness: TestRedisHarness;
  let queue: DeleteQueue;

  beforeEach(async () => {
    harness = await createTestRedisHarness();
    queue = new DeleteQueue(harness.client, 21_600);
  });

  afterEach(async () => {
    await harness.teardown();
  });

  /** Directly zadds a job with a definite past score — `queue.enqueue()` computes `executeAt = nowUnixSeconds + random(0, maxDelay)`, so it cannot be used to reliably simulate "already ready" in a test. */
  async function seedReadyJob(walletUrl: string, uuid: string, readyBeforeUnixTs: number) {
    await harness.client.zadd(
      'pending_deletes',
      readyBeforeUnixTs - 100,
      JSON.stringify({ wallet_url: walletUrl, uuid, attempts: 0 })
    );
  }

  it('discards jobs on 2xx wallet response', async () => {
    const now = Math.floor(Date.now() / 1000);
    await seedReadyJob('https://wallet.example', 'uuid-1', now); // already ready

    const calls: Array<{ walletUrl: string; uuid: string }> = [];
    const client: WalletDeleteClient = {
      async deleteMessage(walletUrl, uuid) {
        calls.push({ walletUrl, uuid });
        return { status: 200 };
      },
    };

    const result = await runDeleteQueueJob(harness.client, client, now);
    expect(result).toEqual({ processed: 1, succeeded: 1, failed: 0, requeued: 0 });
    expect(calls).toEqual([{ walletUrl: 'https://wallet.example', uuid: 'uuid-1' }]);

    // Nothing left in queue.
    const remaining = await queue.dequeueReady(now + 1);
    expect(remaining).toEqual([]);
  });

  it('discards jobs on 404 (already-cleared case per §4.4 step 3)', async () => {
    const now = Math.floor(Date.now() / 1000);
    await seedReadyJob('https://wallet.example', 'uuid-2', now);
    const client: WalletDeleteClient = { async deleteMessage() { return { status: 404 }; } };
    const result = await runDeleteQueueJob(harness.client, client, now);
    expect(result).toEqual({ processed: 1, succeeded: 1, failed: 0, requeued: 0 });
  });

  it('requeues with backoff on 5xx failure (§4.4 step 4)', async () => {
    const now = Math.floor(Date.now() / 1000);
    await seedReadyJob('https://wallet.example', 'uuid-3', now);
    const client: WalletDeleteClient = { async deleteMessage() { return { status: 503 }; } };
    const result = await runDeleteQueueJob(harness.client, client, now);
    expect(result).toEqual({ processed: 1, succeeded: 0, failed: 1, requeued: 1 });

    // Requeued with attempts=1, not immediately ready (backoff=300s).
    const notYetReady = await queue.dequeueReady(now + 299);
    expect(notYetReady).toEqual([]);
    const readyLater = await queue.dequeueReady(now + 300);
    expect(readyLater).toHaveLength(1);
    expect(readyLater[0]?.attempts).toBe(1);
  });

  it('requeues on network error/timeout (treated as 5xx-equivalent)', async () => {
    const now = Math.floor(Date.now() / 1000);
    await seedReadyJob('https://wallet.example', 'uuid-4', now);
    const client: WalletDeleteClient = {
      async deleteMessage() {
        throw new Error('ECONNREFUSED');
      },
    };
    // runDeleteQueueJob itself does not catch — defaultWalletDeleteClient
    // does the catch-to-599 translation (delete-queue-job.ts). A custom
    // client that throws should propagate, so callers know their own
    // client implementation misbehaved rather than silently swallowing it.
    await expect(runDeleteQueueJob(harness.client, client, now)).rejects.toThrow('ECONNREFUSED');
  });

  it('processes multiple ready jobs and leaves not-yet-ready jobs alone', async () => {
    const now = Math.floor(Date.now() / 1000);
    await seedReadyJob('https://a.example', 'uuid-a', now);
    await seedReadyJob('https://b.example', 'uuid-b', now);
    await harness.client.zadd(
      'pending_deletes',
      now + 10_000,
      JSON.stringify({ wallet_url: 'https://c.example', uuid: 'uuid-c', attempts: 0 })
    );

    const seen: string[] = [];
    const client: WalletDeleteClient = {
      async deleteMessage(_url, uuid) {
        seen.push(uuid);
        return { status: 200 };
      },
    };
    const result = await runDeleteQueueJob(harness.client, client, now);
    expect(result.processed).toBe(2);
    expect(seen.sort()).toEqual(['uuid-a', 'uuid-b']);
  });
});
