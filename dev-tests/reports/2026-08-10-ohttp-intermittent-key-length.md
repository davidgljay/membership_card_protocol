# Intermittent "Invalid length of the key" on `/ohttp/gateway`

## Summary

While watching `wrangler tail --env dev` against `press-dev` during a live
`dev-tests` run (2026-08-10), one request failed with an unhandled 500:

```
[request error] [unhandled] [POST] https://press-dev.mcard-relay.workers.dev/ohttp/gateway
{ message: 'Invalid length of the key', statusCode: 500 }
```

It occurred sandwiched between two successful `POST /ohttp/gateway` calls,
all three within about two seconds of each other. It has been observed
exactly once across this session's very heavy volume of `dev-tests` runs
against the live dev deployment (many dozens of runs, both local and CI, in
a single day). It did not correspond to a distinct failed test in that
run's summary — either the calling test tolerated/retried past it, or it
belonged to a test that otherwise passed.

## What it isn't

Ruled out during investigation:

- **Not a misconfigured `PRESS_OHTTP_PRIVATE_KEY` secret.** `config.ts`'s
  `decodeBase64urlKey()` validates this key's decoded length at Worker
  startup and calls `process.exit(1)` if it's wrong — the Worker would be
  crash-looping, not intermittently failing one request in three. It served
  every other request (including the two adjacent successful
  `/ohttp/gateway` calls) using the same static key.
- **Not relay's forwarding logic.** `relay/src/routes/ohttp.ts`'s
  `handleOhttpForward` reads the raw request body and forwards it
  byte-for-byte (`new Uint8Array(body)`) with no JSON parse/reserialize
  step — a true opaque pass-through, nothing to corrupt.
- **Not reproducible in isolation.** Ran `suites/extended/
  oblivious_transport.spec.ts` (the suite that exercises this path most
  directly, via `HpkeObliviousProtocolTransport`) three times back-to-back
  locally against the live dev deployment. All three passed cleanly, 7/7
  tests, no length errors. Whatever triggers this needs something about the
  full suite's request pattern/timing, not this one file's calls alone.

## Where it's actually thrown

`press/src/ohttp-gateway.ts`'s `decapsulate()` passes the *client-supplied*
`enc` field (the request body's ephemeral encapsulated key, sent by
whichever `HpkeObliviousProtocolTransport` caller originated the request)
into `SUITE.createRecipientContext({ enc: ... })`. `SUITE` is a
**module-level singleton** `CipherSuite` instance — both here and in
`app-sdk/dist/crypto/hpke.js`'s client-side equivalent, `hpkeSeal()`/
`hpkeOpen()` share one `SUITE` object across every HPKE operation in the
process, not a fresh instance per call.

## Hypotheses (not yet confirmed)

1. **Press-side concurrency.** A Cloudflare Worker isolate can serve
   multiple concurrent requests within the same JS execution context. If
   `hpke-js`'s `CipherSuite`/KEM operations hold any shared mutable state
   internally (not purely functional per-call), two `/ohttp/gateway`
   requests landing on the same warm isolate close together could
   interfere with each other's key material. This is the most likely
   candidate — Workers' concurrency model makes module-level shared state
   a classic hazard in a way a single-threaded Node process isn't.

2. **Client-side concurrency**, same shape, in `app-sdk`'s `hpke.js` `SUITE`
   singleton — less likely given `vitest.config.ts`'s `fileParallelism:
   false` and that every call site here uses explicit sequential `await`,
   but not ruled out (e.g. a stray unawaited background promise).

3. **Abandoned in-flight request from an earlier hook timeout.** Before
   today's timeout fixes (raising several `beforeAll` hooks that call
   `mintLiveCard` from 30s/60s to 120s/180s — see the "two more dev-tests
   timeout gaps" commits from this same date), multiple requests were
   observed getting cut off mid-flight when vitest's hook timeout fired and
   the test process moved on, showing up as `Canceled` in press's own
   tail. If an abandoned HPKE operation's promise was still resolving
   against the shared `SUITE` singleton when a *new* operation started
   using the same singleton, that overlap could produce exactly this kind
   of intermittent corruption. This ties together with everything else
   found today, and is testable: if it's the real cause, this error should
   become rarer or disappear now that those premature timeouts are fixed
   and fewer requests get abandoned mid-flight.

## Suggested fix, if/when this recurs enough to prioritize

Instantiate a fresh `CipherSuite` per call instead of reusing a
module-level singleton, in both `press/src/ohttp-gateway.ts` and
`app-sdk/src/crypto/hpke.ts` (source; `dist/` is generated). Small
per-call construction cost, but removes shared mutable state as a
possibility entirely — directly addresses hypotheses 1 and 2 regardless of
which one (or both) is real. Hypothesis 3 would already be mitigated by
today's timeout fixes independent of this change.

## Recommendation

Don't chase this further right now — one occurrence in a huge volume of
traffic, not reproducible in isolation, and there's already a live
competing hypothesis (today's timeout fixes) that may have already
mitigated it as a side effect. Watch for recurrence in future `dev-tests`
runs; if it starts showing up with any regularity, the per-call
`CipherSuite` fix above is the first thing to try.
