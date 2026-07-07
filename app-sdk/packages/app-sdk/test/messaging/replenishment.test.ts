import { describe, it, expect, vi } from 'vitest';
import { ReplenishmentScheduler } from '../../src/messaging/replenishment.js';

/**
 * A controllable fake scheduler: `schedule()` records the callback and
 * delay instead of using real timers, and the test drives time forward
 * explicitly via `advance()` and `fireDue()` — this is what lets the test
 * assert "did not fire in the tick immediately after the triggering
 * event" and "does fire on a later tick" without a real multi-second (let
 * alone multi-hour) wait.
 */
function makeFakeScheduler() {
  let now = 0;
  const scheduled: { callback: () => void; delayMs: number; firesAt: number; cancelled: boolean }[] = [];

  return {
    schedule: (callback: () => void, delayMs: number) => {
      const entry = { callback, delayMs, firesAt: now + delayMs, cancelled: false };
      scheduled.push(entry);
      return () => {
        entry.cancelled = true;
      };
    },
    now: () => now,
    /** Advance the fake clock and fire any due, non-cancelled callbacks — simulates "the tick immediately after" when advanced by a small amount, or "a later tick" when advanced past a scheduled delay. */
    advanceAndFireDue: (ms: number) => {
      now += ms;
      for (const entry of scheduled) {
        if (!entry.cancelled && entry.firesAt <= now) {
          entry.callback();
          entry.cancelled = true; // one-shot, mirrors real setTimeout semantics
        }
      }
    },
  };
}

describe('ReplenishmentScheduler (Step 5.4)', () => {
  it('does not replenish in the tick immediately following a simulated message receipt', () => {
    const fake = makeFakeScheduler();
    const onReplenish = vi.fn();
    const scheduler = new ReplenishmentScheduler({
      threshold: 3,
      minDelayMs: 60_000, // 1 minute minimum, matching "minutes to hours"
      maxDelayMs: 6 * 60 * 60 * 1000, // 6 hours maximum
      onReplenish,
      schedule: fake.schedule,
    });

    // Message receipt consumes a UUID, dropping the pool to the threshold.
    scheduler.reportPoolStatus({ subCardHash: 'subcard-1', remaining: 3 });
    expect(scheduler.isScheduled('subcard-1')).toBe(true);

    // "The tick immediately following" — advance by a trivially small
    // amount (far less than minDelayMs), simulating the very next event
    // loop tick after the message receipt that triggered the drop.
    fake.advanceAndFireDue(1);
    expect(onReplenish).not.toHaveBeenCalled();
  });

  it('does replenish once the pool drops to the threshold, on a subsequent randomized-delay tick', () => {
    const fake = makeFakeScheduler();
    const onReplenish = vi.fn();
    const scheduler = new ReplenishmentScheduler({
      threshold: 3,
      minDelayMs: 60_000,
      maxDelayMs: 120_000,
      onReplenish,
      schedule: fake.schedule,
    });

    scheduler.reportPoolStatus({ subCardHash: 'subcard-1', remaining: 2 });
    expect(onReplenish).not.toHaveBeenCalled();

    // Advance past the maximum possible scheduled delay — the
    // replenishment must have fired by now.
    fake.advanceAndFireDue(120_000);
    expect(onReplenish).toHaveBeenCalledWith('subcard-1');
    expect(onReplenish).toHaveBeenCalledTimes(1);
    expect(scheduler.isScheduled('subcard-1')).toBe(false);
  });

  it('does not schedule replenishment when the pool is above the threshold', () => {
    const fake = makeFakeScheduler();
    const onReplenish = vi.fn();
    const scheduler = new ReplenishmentScheduler({
      threshold: 3,
      minDelayMs: 1000,
      maxDelayMs: 2000,
      onReplenish,
      schedule: fake.schedule,
    });

    scheduler.reportPoolStatus({ subCardHash: 'subcard-1', remaining: 10 });
    expect(scheduler.isScheduled('subcard-1')).toBe(false);
    fake.advanceAndFireDue(5000);
    expect(onReplenish).not.toHaveBeenCalled();
  });

  it('does not double-schedule when multiple below-threshold reports arrive before the pending replenishment fires', () => {
    const fake = makeFakeScheduler();
    const onReplenish = vi.fn();
    const scheduler = new ReplenishmentScheduler({
      threshold: 3,
      minDelayMs: 1000,
      maxDelayMs: 2000,
      onReplenish,
      schedule: fake.schedule,
    });

    scheduler.reportPoolStatus({ subCardHash: 'subcard-1', remaining: 3 });
    // Another message receipt consumes one more UUID before replenishment fires.
    scheduler.reportPoolStatus({ subCardHash: 'subcard-1', remaining: 2 });
    scheduler.reportPoolStatus({ subCardHash: 'subcard-1', remaining: 1 });

    fake.advanceAndFireDue(2000);
    expect(onReplenish).toHaveBeenCalledTimes(1);
  });

  it('tracks multiple subcards independently', () => {
    const fake = makeFakeScheduler();
    const onReplenish = vi.fn();
    const scheduler = new ReplenishmentScheduler({
      threshold: 3,
      minDelayMs: 1000,
      maxDelayMs: 1000,
      onReplenish,
      schedule: fake.schedule,
    });

    scheduler.reportPoolStatus({ subCardHash: 'subcard-a', remaining: 2 });
    scheduler.reportPoolStatus({ subCardHash: 'subcard-b', remaining: 1 });

    fake.advanceAndFireDue(1000);
    expect(onReplenish).toHaveBeenCalledWith('subcard-a');
    expect(onReplenish).toHaveBeenCalledWith('subcard-b');
    expect(onReplenish).toHaveBeenCalledTimes(2);
  });

  it('cancel() prevents a pending replenishment from firing', () => {
    const fake = makeFakeScheduler();
    const onReplenish = vi.fn();
    const scheduler = new ReplenishmentScheduler({
      threshold: 3,
      minDelayMs: 1000,
      maxDelayMs: 1000,
      onReplenish,
      schedule: fake.schedule,
    });

    scheduler.reportPoolStatus({ subCardHash: 'subcard-1', remaining: 1 });
    scheduler.cancel('subcard-1');
    fake.advanceAndFireDue(1000);
    expect(onReplenish).not.toHaveBeenCalled();
  });
});
