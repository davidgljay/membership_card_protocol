/**
 * `specs/process_specs/oblivious_transport.md` end-to-end, against the live
 * dev deployment. Ported from
 * integration_tests/suites/extended/oblivious_transport.spec.ts unchanged
 * in test logic -- only import sources changed: published `app-sdk`,
 * `InMemorySecureKeyProvider` from `../../support/keys.js`, and
 * `RELAY_BASE_URL`/`WALLET_SERVICE_BASE_URL`/`pressCardCid` obtained from
 * `../../support/liveCard.js` instead of `process.env.SUITE_*`.
 *
 * Covers the device→relay→destination OHTTP path: HPKE key-configuration
 * discovery, request encapsulation, opaque relay forwarding, and
 * destination-side decapsulation/dispatch, against the real running relay
 * and press. Uses app-sdk's real `HpkeObliviousProtocolTransport` — the
 * same class a real device would use.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import {
  HpkeObliviousProtocolTransport,
  assembleAndSignTargetedOffer,
  keccak256,
} from '@membership-card-protocol/app-sdk';
import { mintLiveCard, ensureLiveGovernance, getPressCardCid, PRESS_BASE_URL, RELAY_BASE_URL, WALLET_SERVICE_BASE_URL, type LiveIdentity } from '../../support/liveCard.js';
import { InMemorySecureKeyProvider } from '../../support/keys.js';

interface KeyConfigResponse {
  kemId: number;
  kdfId: number;
  aeadId: number;
  publicKey: string;
  targetId: string;
}

describe('oblivious_transport.md (live dev deployment)', () => {
  let governance: ReturnType<typeof ensureLiveGovernance>;
  let pressCardCid: string;
  let issuer: LiveIdentity;

  beforeAll(async () => {
    governance = ensureLiveGovernance();
    pressCardCid = await getPressCardCid();
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
      const response = await transport.request(
        { kind: 'press', baseUrl: PRESS_BASE_URL },
        { method: 'GET', path: '/api/press' }
      );
      expect(response.status).toBe(404);
      const body = JSON.parse(new TextDecoder().decode(response.body)) as { error?: string };
      expect(body.error).toBe('NOT_REACHABLE');
    }, 15_000);

    it('§Scope: POST /api/issue (a sensitive, oblivious-routed press endpoint) succeeds through the real oblivious path', async () => {
      const secureKeyProvider = new InMemorySecureKeyProvider();
      const issuerKeyId = `oblivious-issuer:${Date.now()}`;
      const issuerPubkey = await secureKeyProvider.generateKey(issuerKeyId);
      const issuerAddress = keccak256(issuerPubkey);

      const offer = await assembleAndSignTargetedOffer({
        secureKeyProvider,
        issuerSigningKeyId: issuerKeyId,
        policyId: governance.policyId,
        issuerCard: issuerAddress,
        pressCard: pressCardCid,
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
        { method: 'POST', path: '/api/issue', headers: { 'content-type': 'application/json' }, body: requestBody }
      );

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
        pressCard: pressCardCid,
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

      const bypassResponse = await transport.request(
        { kind: 'press', baseUrl: PRESS_BASE_URL },
        { method: 'POST', path: '/api/issue', headers: { 'content-type': 'application/json' }, bypass: true, body: requestBody }
      );
      expect(bypassResponse.status).toBe(200);
      const body = JSON.parse(new TextDecoder().decode(bypassResponse.body)) as { offer_cid?: string };
      expect(body.offer_cid).toBeTruthy();
    }, 20_000);
  });
});
