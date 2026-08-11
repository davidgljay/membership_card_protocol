/**
 * Global fetch() timeout + single retry, installed once for the whole
 * dev-tests run via vitest.config.ts's `setupFiles`.
 *
 * Found live: dev-tests makes 100+ raw `fetch()` calls across ~20 spec
 * files against a real live dev deployment, none of them with any
 * request-level timeout. undici's fetch() has no default timeout -- when a
 * request occasionally just hangs (no response, connection never closes),
 * the call waits indefinitely. This isn't hypothetical: one run's
 * `oblivious_transport.spec.ts` reported its own beforeAll hook timing out
 * at 120s (vitest's timeout), but the *suite's* total reported duration was
 * 928,657ms (~15.5 minutes) -- vitest gave up waiting on the test, but
 * something underneath kept the process from cleanly moving on for another
 * ~13+ minutes. `notification_relay.spec.ts` showed the same shape,
 * 1,073,465ms (~18 minutes) for what should be a fast suite.
 *
 * Fix: wrap every fetch() call in a 150s AbortController, and retry once
 * (only) if the attempt throws. Per the Fetch API spec, fetch() only
 * *rejects* for network-level failures (DNS failure, connection reset,
 * abort/timeout, TLS errors, etc.) -- a completed HTTP response, including
 * a 4xx/5xx, always *resolves* normally, never throws. That means "retry
 * only in the catch block" is automatically exactly the right scope: it
 * can never retry (and so can never mask) a deterministic error response a
 * test is asserting against -- only a genuinely transient "nothing came
 * back at all" failure gets a second attempt, once, with a short fixed
 * backoff.
 *
 * 150s, not something shorter: this first shipped at 20s and immediately
 * caused a real regression, confirmed live -- press's POST /issue/finalize
 * (and others) synchronously await on-chain confirmation before
 * responding, so a *single* fetch() to one of these endpoints can
 * legitimately take up to ~120s under real network conditions (the same
 * ceiling this suite's own beforeAll/it timeouts were independently tuned
 * to elsewhere the same day). A 20s abort turned "slow but would have
 * succeeded" into a hard failure after two ~20s attempts. This value must
 * stay safely above every legitimate single-request duration already
 * established in this suite (120s), not below it -- it exists to catch
 * genuinely pathological multi-minute hangs (the 15-18 minute ones that
 * motivated this file), not to second-guess already-tuned test timeouts.
 */

const REQUEST_TIMEOUT_MS = 150_000;
const RETRY_BACKOFF_MS = 500;

type FetchInput = Parameters<typeof fetch>[0];
type FetchInit = Parameters<typeof fetch>[1];

const originalFetch = globalThis.fetch;

async function attempt(input: FetchInput, init?: FetchInit): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await originalFetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchWithTimeoutAndRetry(input: FetchInput, init?: FetchInit): Promise<Response> {
  try {
    return await attempt(input, init);
  } catch {
    await new Promise((resolve) => setTimeout(resolve, RETRY_BACKOFF_MS));
    return await attempt(input, init);
  }
}

globalThis.fetch = fetchWithTimeoutAndRetry as typeof fetch;
