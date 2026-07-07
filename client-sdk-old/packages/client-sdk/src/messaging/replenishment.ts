/**
 * Replenishment scheduling (Step 5.4): `notification_relay.md
 * §Replenishment` — "The device replenishes UUID pools proactively before
 * they run low, on a randomized schedule. Replenishment is never
 * triggered immediately after a message is received, as that timing
 * pattern would allow the wallet service to correlate old and new UUID
 * batches." Suggested threshold: replenish when 3 or fewer UUIDs remain.
 *
 * **Anti-correlation is the entire reason this is a scheduler, not a
 * direct call.** The naive implementation — replenish synchronously the
 * moment a pool drops to the threshold, which typically happens right
 * after consuming a UUID for message delivery — would produce exactly
 * the timing signature the spec warns against: a wallet service that
 * observes "UUID pool for subcard X emptied, then moments later a fresh
 * batch registered for subcard X" can correlate the two registrations
 * even though each individually passes through the oblivious-relay path
 * and per-card session separation (Step 5.3). This module decouples
 * "pool dropped to threshold" (an event, observed on every message
 * receipt) from "replenishment fires" (an action, scheduled for a later,
 * independently-randomized tick) — the two are never the same tick.
 */

export interface PoolStatus {
  subCardHash: string;
  remaining: number;
}

export interface ReplenishmentSchedulerOptions {
  /** Replenish when a pool's remaining count is at or below this. Default 3, per the spec's suggested threshold. */
  threshold?: number;
  /** Minimum randomized delay before a scheduled replenishment fires, ms. */
  minDelayMs: number;
  /** Maximum randomized delay before a scheduled replenishment fires, ms. */
  maxDelayMs: number;
  /** Called once a scheduled replenishment's randomized delay elapses. */
  onReplenish: (subCardHash: string) => void | Promise<void>;
  /** Injectable clock, for testing. Defaults to `Date.now`. */
  now?: () => number;
  /** Injectable scheduler, for testing (avoids real multi-hour waits). Defaults to `setTimeout`; returns a cancel function. */
  schedule?: (callback: () => void, delayMs: number) => () => void;
}

interface ScheduledEntry {
  cancel: () => void;
  scheduledAt: number;
  firesAt: number;
}

function defaultSchedule(callback: () => void, delayMs: number): () => void {
  const handle = setTimeout(callback, delayMs);
  return () => clearTimeout(handle);
}

const DEFAULT_THRESHOLD = 3;

/**
 * Tracks per-subcard UUID pool levels and schedules replenishment on a
 * randomized future tick once a pool crosses the threshold — never on the
 * same tick as the triggering event, so a message-receipt-driven pool
 * decrement can never be observed to fire replenishment "immediately."
 *
 * A caller reports pool state via {@link reportPoolStatus} on every event
 * that changes a pool's size (UUID consumed on message delivery, UUID
 * consumed on WebSocket session start, successful replenishment
 * completing). This scheduler does not itself know *why* a pool changed
 * size — that decoupling is what prevents "replenish in the same tick
 * that triggered the drop" from being representable at all: there is no
 * code path from `reportPoolStatus` to `onReplenish` that does not pass
 * through the randomized-delay scheduling step.
 */
export class ReplenishmentScheduler {
  readonly #threshold: number;
  readonly #minDelayMs: number;
  readonly #maxDelayMs: number;
  readonly #onReplenish: (subCardHash: string) => void | Promise<void>;
  readonly #schedule: (callback: () => void, delayMs: number) => () => void;
  readonly #pending = new Map<string, ScheduledEntry>();

  constructor(options: ReplenishmentSchedulerOptions) {
    this.#threshold = options.threshold ?? DEFAULT_THRESHOLD;
    this.#minDelayMs = options.minDelayMs;
    this.#maxDelayMs = options.maxDelayMs;
    this.#onReplenish = options.onReplenish;
    this.#schedule = options.schedule ?? defaultSchedule;
  }

  /**
   * Report the current pool size for a subcard. If `remaining` is at or
   * below the threshold and no replenishment is already scheduled for
   * this subcard, schedules one at a randomized future delay. A
   * subsequent report for the same subcard while a replenishment is
   * already pending is a no-op — this prevents redundant duplicate
   * scheduling from every intervening message receipt.
   */
  reportPoolStatus(status: PoolStatus): void {
    if (status.remaining > this.#threshold) {
      return;
    }
    if (this.#pending.has(status.subCardHash)) {
      return;
    }

    const delay = this.#minDelayMs + Math.random() * (this.#maxDelayMs - this.#minDelayMs);
    const cancel = this.#schedule(() => {
      this.#pending.delete(status.subCardHash);
      void this.#onReplenish(status.subCardHash);
    }, delay);

    this.#pending.set(status.subCardHash, {
      cancel,
      scheduledAt: Date.now(),
      firesAt: Date.now() + delay,
    });
  }

  /** Whether a replenishment is currently scheduled (not yet fired) for `subCardHash`. */
  isScheduled(subCardHash: string): boolean {
    return this.#pending.has(subCardHash);
  }

  /** Cancel a pending scheduled replenishment, if any (e.g. subcard deregistered before its replenishment tick). */
  cancel(subCardHash: string): void {
    const entry = this.#pending.get(subCardHash);
    if (entry) {
      entry.cancel();
      this.#pending.delete(subCardHash);
    }
  }

  /** Cancel every pending scheduled replenishment (e.g. on app shutdown). */
  cancelAll(): void {
    for (const subCardHash of [...this.#pending.keys()]) {
      this.cancel(subCardHash);
    }
  }
}
