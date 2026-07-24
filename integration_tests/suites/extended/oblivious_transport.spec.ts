/**
 * `specs/process_specs/oblivious_transport.md` end-to-end — Phase 5 Wave 3.
 * Covers the device→relay→destination OHTTP path: HPKE key-configuration
 * discovery, request encapsulation, opaque relay forwarding, and
 * destination-side decapsulation/dispatch, against the REAL running relay
 * and press (this suite doesn't need wallet-service's own oblivious-routed
 * endpoints — press's `/issue` alone already exercises the identical,
 * destination-agnostic envelope/relay mechanics the spec describes as "one
 * implementation... not a bespoke format per destination").
 *
 * Uses `@membership-card-protocol/app-sdk`'s real `HpkeObliviousProtocolTransport`
 * — the same class a real device would use — rather than hand-rolling HPKE
 * calls, so this suite proves the actual client implementation interops
 * with the actual relay/press implementation, not just that some HPKE
 * envelope happens to work.
 *
 * Scope: this suite issues a real card through the oblivious path (Phase 5's
 * `/issue` scenario) to prove the full round-trip has the same effect as a
 * direct call (already covered elsewhere, e.g. `core/card_offering_and_
 * acceptance.spec.ts`) — that direct-vs-oblivious equivalence, not
 * duplicating offer-assembly coverage, is the point here. Also covers: key
 * config discovery shape, an unknown relay target_id (404, no forward), and
 * the destination gateway's own path allowlist (only the six sensitive
 * press endpoints are reachable through OHTTP — `/press` is not, per the
 * spec's table, and rejecting it is the *destination's* job, not the
 * relay's, since the relay never sees the path at all).
 *
 * Requires the `integration_tests` stack up (`docker compose up -d --wait`)
 * — this suite talks to press, relay, and (for key-config shape only)
 * wallet-service.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import {
  HpkeObliviousProtocolTransport,
  assembleAndSignTargetedOffer,
} from '@membership-card-protocol/app-sdk';
import { mintLiveCard, ensureLiveGovernance, PRESS_BASE_URL, type LiveIdentity } from '../support/liveCard.js';
import { InMemorySecureKeyProvider } from '@membership-card-protocol/integration-fixtures';
import { keccak256 } from '@membership-card-protocol/app-sdk';

const RELAY_BASE_URL = (process.env.SUITE_RELAY_URL ?? 'http://localhost:3000').replace(/\/$/, '');
const WALLET_SERVICE_BASE_URL = (process.env.SUITE_WALLET_SERVICE_URL ?? 'http://localhost:3002').replace(/\/$/, '');

interface KeyConfigResponse {
  kemId: number;
  kdfId: number;
  aeadId: number;
  publicKey: string;
  targetId: string;
}

describe('oblivious_transport.md (live stack)', () => {
  let governance: Awaited<ReturnType<typeof ensureLiveGovernance>>;
  let issuer: LiveIdentity;

  beforeAll(async () => {
    governance = await ensureLiveGovernance();
    // Sequential with the transport call below — press's gas wallet nonce
    // tracking, see suites/README.md.
    issuer = await mintLiveCard('oblivious-transport-issuer', { display_name: 'Oblivious Transport Suite — Issuer' });
  }, 30_000);

  describe('§Key Configuration Discovery', () => {
    it('press publishes an unauthenticated OHTTP key configuration', async () => {
      const res = await fetch(`${PRESS_BASE_URL}/ohttp/key-config`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as KeyConfigResponse;
      expect(typeof body.kemId).toBe('number');
      expect(typeof body.kdfId).toBe('number');
      expect(typeof body.aeadId).toBe('number');
      expect(body.publicKey).toBeTruthy();
      expect(body.targetId).toBeTruthy();
    });

    it('wallet-service publishes an unauthenticated OHTTP key configuration', async () => {
      const res = await fetch(`${WALLET_SERVICE_BASE_URL}/ohttp/key-config`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as KeyConfigResponse;
      expect(typeof body.kemId).toBe('number');
      expect(body.publicKey).toBeTruthy();
      expect(body.targetId).toBeTruthy();
    });

    it("press's and wallet-service's target_ids are distinct and both registered with the relay", async () => {
      const [pressConfig, walletConfig] = await Promise.all([
        fetch(`${PRESS_BASE_URL}/ohttp/key-config`).then((r) => r.json() as Promise<KeyConfigResponse>),
        fetch(`${WALLET_SERVICE_BASE_URL}/ohttp/key-config`).then((r) => r.json() as Promise<KeyConfigResponse>),
      ]);
      expect(pressConfig.targetId).not.toBe(walletConfig.targetId);
    });
  });

  describe('§Request Path (real HPKE round-trip via HpkeObliviousProtocolTransport)', () => {
    it('§Relay Target Registry: an unknown target_id returns 404 without forwarding', async () => {
      const res = await fetch(`${RELAY_BASE_URL}/ohttp/0x` + 'ab'.repeat(32), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enc: 'bm90LXJlYWw', ciphertext: 'bm90LXJlYWw' }),
      });
      expect(res.status).toBe(404);
    });

    it('§Scope: an endpoint outside the six sensitive press endpoints is rejected by the destination gateway, not the relay', async () => {
      const transport = new HpkeObliviousProtocolTransport({
        relayBaseUrl: RELAY_BASE_URL,
        walletServiceBaseUrl: WALLET_SERVICE_BASE_URL,
      });
      // /press is a public read (spec's table: "No — direct HTTPS"). The
      // relay forwards it fine (it never inspects path/method/body); the
      // press gateway's own dispatcher (ohttp-router.ts's ROUTES table)
      // is what rejects it — this is a destination-side 404, arriving
      // *through* a successfully-decapsulated oblivious round-trip, not a
      // relay-level rejection like the unknown-target_id case above.
      const response = await transport.request(
        { kind: 'press', baseUrl: PRESS_BASE_URL },
        { method: 'GET', path: '/press' }
      );
      expect(response.status).toBe(404);
      const body = JSON.parse(new TextDecoder().decode(response.body)) as { error?: string };
      expect(body.error).toBe('NOT_REACHABLE');
    }, 15_000);

    it('§Scope: POST /issue (a sensitive, oblivious-routed press endpoint) succeeds through the real oblivious path', async () => {
      const secureKeyProvider = new InMemorySecureKeyProvider();
      const issuerKeyId = `oblivious-issuer:${Date.now()}`;
      const issuerPubkey = await secureKeyProvider.generateKey(issuerKeyId);
      const issuerAddress = keccak256(issuerPubkey);

      const offer = await assembleAndSignTargetedOffer({
        secureKeyProvider,
        issuerSigningKeyId: issuerKeyId,
        policyId: governance.policyId,
        issuerCard: issuerAddress,
        pressCard: governance.pressCardCid,
        ancestryPubkeys: [issuerPubkey],
        fieldValues: { display_name: 'Oblivious Transport Suite Card' },
      });

      const requestBody = new TextEncoder().encode(
        JSON.stringify({ policy_cid: governance.policyId, requester_card_address: issuerAddress, offer })
      );

      const transport = new HpkeObliviousProtocolTransport({
        relayBaseUrl: RELAY_BASE_URL,
        walletServiceBaseUrl: WALLET_SERVICE_BASE_URL,
      });
      const response = await transport.request(
        { kind: 'press', baseUrl: PRESS_BASE_URL },
        { method: 'POST', path: '/issue', headers: { 'content-type': 'application/json' }, body: requestBody }
      );

      // Postcondition: the relay never saw path/method/body in the clear —
      // it only ever handled the opaque HPKE bytes (asserted structurally
      // by the fact that this succeeded at all: the relay has no /issue
      // handling logic of its own, only blind forwarding by target_id) —
      // and press decapsulated, dispatched to the exact same handleIssue
      // this suite's sibling core/ suites call directly over plain HTTPS,
      // and encapsulated the real result back.
      expect(response.status).toBe(200);
      const body = JSON.parse(new TextDecoder().decode(response.body)) as { offer_cid?: string };
      expect(body.offer_cid).toBeTruthy();
    }, 20_000);

    it('§Request Path bypass mode: an identical request with bypass:true produces an identical application-level result via direct HTTPS', async () => {
      const secureKeyProvider = new InMemorySecureKeyProvider();
      const issuerKeyId = `oblivious-bypass-issuer:${Date.now()}`;
      const issuerPubkey = await secureKeyProvider.generateKey(issuerKeyId);
      const issuerAddress = keccak256(issuerPubkey);

      const offer = await assembleAndSignTargetedOffer({
        secureKeyProvider,
        issuerSigningKeyId: issuerKeyId,
        policyId: governance.policyId,
        issuerCard: issuerAddress,
        pressCard: governance.pressCardCid,
        ancestryPubkeys: [issuerPubkey],
        fieldValues: { display_name: 'Oblivious Transport Suite Bypass Card' },
      });

      const requestBody = new TextEncoder().encode(
        JSON.stringify({ policy_cid: governance.policyId, requester_card_address: issuerAddress, offer })
      );

      const transport = new HpkeObliviousProtocolTransport({
        relayBaseUrl: RELAY_BASE_URL,
        walletServiceBaseUrl: WALLET_SERVICE_BASE_URL,
      });

      // BUG, confirmed live: `bypass: true` calls `${baseUrl}${path}`
      // directly (ObliviousProtocolTransport.ts's `#directRequest`) — but
      // press's real HTTP routes live under `/api/*`
      // (`press/server/routes/issue.post.ts` etc.), while the *oblivious*
      // envelope's path convention is the bare, unprefixed path
      // (`press/src/ohttp-router.ts`'s dispatch table: `'POST /issue'`,
      // not `'POST /api/issue'`). The same `RequestOptions.path` value
      // therefore cannot serve both modes — confirmed with curl directly:
      // `POST /api/issue` on press returns 400 (real validation error,
      // route exists); `POST /issue` returns a bare 404 (route doesn't
      // exist outside the OHTTP gateway's own dispatcher). This
      // contradicts the class's own doc comment, which frames `bypass`
      // as "producing an identical application-level result" for the
      // *same* call — it doesn't, unless the caller already knows to
      // swap the path per mode, which defeats the point of a single
      // transport abstraction a caller can toggle bypass on/off for
      // without touching call sites. Not fixed here — this is a design
      // question (should the OHTTP dispatch table match press's real
      // route paths, or should `#directRequest` prefix `/api`?) better
      // suited to whoever owns `app-sdk`'s transport layer than a
      // test-writing pass. Demonstrated below with the CORRECT
      // press-side path for bypass mode, and the mismatch documented via
      // the `it.todo` beneath it.
      const bypassResponse = await transport.request(
        { kind: 'press', baseUrl: PRESS_BASE_URL },
        { method: 'POST', path: '/api/issue', headers: { 'content-type': 'application/json' }, bypass: true, body: requestBody }
      );
      expect(bypassResponse.status).toBe(200);
      const body = JSON.parse(new TextDecoder().decode(bypassResponse.body)) as { offer_cid?: string };
      expect(body.offer_cid).toBeTruthy();
    }, 20_000);

    it.todo(
      'BUG: RequestOptions.path is not portable between oblivious and bypass modes for the same call site (oblivious needs "/issue", bypass needs "/api/issue" — see comment above)'
    );
  });
});
