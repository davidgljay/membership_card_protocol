import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestRedisHarness, type TestRedisHarness } from './test-harness';
import { DeleteQueue } from './delete-queue';

describe('DeleteQueue (relay_data_model.md §4)', () => {
  let harness: TestRedisHarness;
  let queue: DeleteQueue;

  beforeEach(async () => {
    harness = await createTestRedisHarness();
    queue = new DeleteQueue(harness.client, 21_600);
  });

  afterEach(async () => {
    await harness.teardown();
  });

  it('enqueues a job with execute_at within [now, now+maxDelay]', async () => {
    const now = Math.floor(Date.now() / 1000);
    await queue.enqueue('https://wallet.example', 'uuid-1', now);

    // Not ready yet at "now" unless the random delay happened to be 0 —
    // use now + maxDelay + 1 to guarantee readiness for this assertion.
    const jobs = await queue.dequeueReady(now + 21_601);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toEqual({ wallet_url: 'https://wallet.example', uuid: 'uuid-1', attempts: 0 });
  });

  it('dequeueReady only returns jobs with score <= now, atomically removing them', async () => {
    const now = Math.floor(Date.now() / 1000);
    await harness.client.zadd('pending_deletes', now - 10, JSON.stringify({ wallet_url: 'https://a', uuid: 'past', attempts: 0 }));
    await harness.client.zadd('pending_deletes', now + 10_000, JSON.stringify({ wallet_url: 'https://b', uuid: 'future', attempts: 0 }));

    const ready = await queue.dequeueReady(now);
    expect(ready.map((j) => j.uuid)).toEqual(['past']);

    // Second call finds nothing more ready (already removed).
    const readyAgain = await queue.dequeueReady(now);
    expect(readyAgain).toEqual([]);

    // The future job is still queued.
    const stillReady = await queue.dequeueReady(now + 10_001);
    expect(stillReady.map((j) => j.uuid)).toEqual(['future']);
  });

  it('requeueWithBackoff increments attempts and applies exponential backoff', async () => {
    const now = Math.floor(Date.now() / 1000);
    const job = { wallet_url: 'https://wallet.example', uuid: 'uuid-x', attempts: 0 };
    await queue.requeueWithBackoff(job, now);

    // base_delay=300, attempts=0 -> backoff=300*2^0=300
    const notReadyYet = await queue.dequeueReady(now + 299);
    expect(notReadyYet).toEqual([]);

    const readyNow = await queue.dequeueReady(now + 300);
    expect(readyNow).toHaveLength(1);
    expect(readyNow[0]?.attempts).toBe(1);
  });

  it('backoff is capped at 86400 seconds', async () => {
    const now = Math.floor(Date.now() / 1000);
    // attempts=10 -> 300*2^10 = 307200, capped to 86400
    const job = { wallet_url: 'https://wallet.example', uuid: 'uuid-y', attempts: 10 };
    await queue.requeueWithBackoff(job, now);

    const notReady = await queue.dequeueReady(now + 86_399);
    expect(notReady).toEqual([]);
    const ready = await queue.dequeueReady(now + 86_400);
    expect(ready).toHaveLength(1);
    expect(ready[0]?.attempts).toBe(11);
  });
});
