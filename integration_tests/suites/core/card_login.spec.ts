/**
 * process_specs/card_login.md — card login against the live local stack
 * (implementation plan step 5.1). Every test names the acceptance criterion
 * it covers (card_login.md §Acceptance Criteria). The world is built with the
 * real SDK functions (support/loginWorld.ts); the site (app-sdk) and wallet
 * (wallet-sdk) run in-process, and the verifier and press talk to the real
 * chain and IPFS. Browser behavior (router, cookies, form_post navigation) is
 * covered by harnesses/web/test/login.spec.ts.
 *
 * Not covered here: routed delivery of mcard_message between wallet services —
 * fan-out needs each sub-card's ML-KEM key, which no protocol field records
 * yet (code plan F10). The cross-device test hands the envelopes over
 * in-process and checks everything else.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Hex } from 'viem';
import {
  createLoginRequest,
  serveLoginRequest,
  createInMemoryLoginStore,
  handleFormPost,
  handleLoginMessage,
  redeemLoginCode,
  parseWalletStart,
  canonicalize,
  mlDsa44Sign,
  bytesToBase64Url,
  type LoginStore,
} from '@membership-card-protocol/app-sdk';
import {
  fetchAndValidateLoginRequest,
  matchLoginCredentials,
  buildLoginResponse,
  formPostFields,
  handleAuthConfirmation,
  createInMemoryPendingWalletLoginStore,
  startWalletInitiatedLogin,
  shouldSkipPrompt,
  postCardUpdate,
  type LoginHandoff,
} from '@membership-card-protocol/wallet-sdk';
import { flagDomainFraudRisk, type GovernanceKeypair } from '@membership-card-protocol/integration-fixtures';
import { readCardFields } from '@membership-card-protocol/verifier';
import { buildLoginWorld, directTransport, type LoginWorld } from '../support/loginWorld.js';
import { PRESS_BASE_URL, ARBITRUM_RPC_URL } from '../support/liveCard.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');

/** The reference site's login state, with requests served in-process. */
function createSite(w: LoginWorld) {
  const store: LoginStore = createInMemoryLoginStore();
  return {
    store,
    async issue(responseMode: 'form_post' | 'mcard_message', extra: { walletNonce?: string; policy?: string } = {}) {
      const r = await createLoginRequest({
        server: w.server,
        keyProvider: w.server.keyProvider,
        store,
        policies: [{ id: extra.policy ?? w.policyAddress, include_children: false }],
        responseMode,
        responseUri: `${w.origin}/login/cb`,
        purpose: 'Log in to the member forum',
        ...(extra.walletNonce ? { walletNonce: extra.walletNonce } : {}),
      });
      return { ...r, url: `${w.origin}/login/r/${r.requestId}` };
    },
    fetch: (async (input: string | URL | Request) => {
      const r = await serveLoginRequest(store, String(input).split('/login/r/')[1]!);
      return new Response(r.status === 200 ? JSON.stringify(r.body) : 'gone', { status: r.status });
    }) as typeof fetch,
  };
}

/**
 * app-sdk resolves its own installed copy of the verifier, so its
 * CardVerifier parameter type is nominally distinct from this suite's (the
 * class has a private field). Same runtime object; cast at the boundary.
 */
const forSite = (w: LoginWorld) => w.verifier as never;

/** The wallet: validate, match, and sign with the user's device sub-card. */
async function walletRespond(w: LoginWorld, site: ReturnType<typeof createSite>, url: string, via: LoginHandoff['via'] = 'router') {
  const validated = await fetchAndValidateLoginRequest({ handoff: { requestUri: url, via }, verifier: w.verifier, fetch: site.fetch });
  if (!validated.valid) throw new Error(`wallet rejected the request: ${validated.code}: ${validated.reason}`);
  const matches = await matchLoginCredentials({ request: validated.request, heldCards: [{ pubkey: w.user.pubkey }], chain: w.chain });
  if (matches.length === 0) return { validated, matches, response: undefined, envelope: undefined, messageId: undefined };
  const built = await buildLoginResponse({ validated, presentedCard: matches[0]!.card, signer: { publicKey: w.device.publicKey, sign: w.device.sign }, protocolVersion: '0.1' });
  return { validated, matches, ...built };
}

function dnsOptions() {
  const deployment = JSON.parse(readFileSync(join(REPO_ROOT, 'contracts/deployments/local.json'), 'utf-8')) as {
    contracts: { logic_contract: string; storage_contract: string };
    dev_governance_keypair: GovernanceKeypair;
  };
  return {
    rpcUrl: ARBITRUM_RPC_URL,
    logicAddress: deployment.contracts.logic_contract as Hex,
    storageAddress: deployment.contracts.storage_contract as Hex,
    governanceKeypair: deployment.dev_governance_keypair,
    contractsScriptsDir: join(REPO_ROOT, 'contracts/scripts'),
  };
}

/** Posts a sub-card document straight to the press, returning the press's error code (or null). */
async function registerSubCardRaw(doc: Record<string, unknown>, appSecretKey: Uint8Array, holderSecretKey: Uint8Array): Promise<string | null> {
  const app_signature = bytesToBase64Url(mlDsa44Sign(appSecretKey, canonicalize(doc)));
  const withApp = { ...doc, app_signature };
  const holder_signature = bytesToBase64Url(mlDsa44Sign(holderSecretKey, canonicalize(withApp)));
  const res = await fetch(`${PRESS_BASE_URL}/api/sub-card/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sub_card_document: withApp, holder_signature }),
  });
  return res.ok ? null : ((await res.json()) as { error: string }).error;
}

describe('card_login.md (live stack)', () => {
  let w: LoginWorld;

  beforeAll(async () => {
    w = await buildLoginWorld();
  }, 600_000);

  describe('Phase 0 setup', () => {
    it('the login service card carries the domain binding (code 520) and lists the server card (code 510)', async () => {
      const fields = (await readCardFields(w.service.pubkey, w.chain))?.fields;
      expect(fields?.['domain_binding']).toMatchObject({ domain: w.domain, login_service_card: w.service.address });
      expect(fields?.['active_subcards']).toContain(w.server.pubkey);
    });

    it('verifyServerCard accepts the server card for an origin under the bound domain', async () => {
      const r = await w.verifier.verifyServerCard(w.server.pubkey, { origin: w.origin });
      expect(r).toMatchObject({ valid: true, login_service_card: w.service.address, domain: w.domain, warnings: [] });
    });

    it('card_login §AC: wrong-origin phishing — the same server card for another domain → LOGIN_ORIGIN_NOT_BOUND', async () => {
      expect(await w.verifier.verifyServerCard(w.server.pubkey, { origin: 'https://login.example.net' })).toMatchObject({ valid: false, code: 'LOGIN_ORIGIN_NOT_BOUND' });
    });
  });

  describe('same device (form_post)', () => {
    it('card_login §AC: a valid response with the matching state cookie logs in as the presented card; request_uri then returns 410', async () => {
      const site = createSite(w);
      const { url, state, requestId } = await site.issue('form_post');
      const { validated, response } = await walletRespond(w, site, url);
      const { fields } = formPostFields(validated.request, response!);
      const r = await handleFormPost({ body: fields, cookieState: state, store: site.store, verifier: forSite(w), expectedOrigin: w.origin });
      expect(r).toMatchObject({ ok: true, presentedCard: w.user.address });
      expect((await serveLoginRequest(site.store, requestId)).status).toBe(410);
    });

    it('card_login §AC: the same response from a browser without the cookie → LOGIN_SESSION_MISMATCH', async () => {
      const site = createSite(w);
      const { url } = await site.issue('form_post');
      const { validated, response } = await walletRespond(w, site, url);
      const r = await handleFormPost({ body: formPostFields(validated.request, response!).fields, cookieState: undefined, store: site.store, verifier: forSite(w), expectedOrigin: w.origin });
      expect(r).toMatchObject({ ok: false, code: 'LOGIN_SESSION_MISMATCH' });
    });

    it('card_login §AC: a response checked by a different origin → LOGIN_AUDIENCE_MISMATCH', async () => {
      const site = createSite(w);
      const { url, state } = await site.issue('form_post');
      const { validated, response } = await walletRespond(w, site, url);
      const r = await handleFormPost({ body: formPostFields(validated.request, response!).fields, cookieState: state, store: site.store, verifier: forSite(w), expectedOrigin: 'https://login.example.net' });
      expect(r).toMatchObject({ ok: false, code: 'LOGIN_AUDIENCE_MISMATCH' });
    });

    it('a card under a policy the site does not accept has no match', async () => {
      const site = createSite(w);
      const { url } = await site.issue('form_post', { policy: 'ab'.repeat(32) });
      const { matches } = await walletRespond(w, site, url);
      expect(matches).toEqual([]);
    });
  });

  describe('cross device (mcard_message + one-time code)', () => {
    it('card_login §AC: the login completes only with the state cookie AND the code; the code works once', async () => {
      const site = createSite(w);
      const { url, state } = await site.issue('mcard_message');
      const { validated, envelope, messageId } = await walletRespond(w, site, url, 'qr');
      const confirmations: unknown[] = [];
      const latencies: number[] = [];
      const received = await handleLoginMessage({
        envelope: envelope as never,
        messageId: messageId!,
        store: site.store,
        verifier: forSite(w),
        expectedOrigin: w.origin,
        server: w.server,
        loginServiceCard: w.service.address,
        keyProvider: w.server.keyProvider,
        protocolVersion: '0.1',
        sendConfirmation: async (_to, env) => void confirmations.push(env),
        onLatency: (s) => void latencies.push(s.latencyMs),
      });
      expect(received).toMatchObject({ ok: true, state });
      expect(latencies).toHaveLength(1);

      const handoff = handleAuthConfirmation({ envelope: confirmations[0] as never, sentResponseId: messageId!, validated, via: 'qr' });
      expect(handoff).toMatchObject({ ok: true, action: 'show' });
      const code = (handoff as { code: string }).code;

      expect(await redeemLoginCode({ code, cookieState: undefined, store: site.store })).toMatchObject({ ok: false, code: 'LOGIN_SESSION_MISMATCH' });
      expect(await redeemLoginCode({ code, cookieState: state, store: site.store })).toMatchObject({ ok: true, presentedCard: w.user.address });
      expect(await redeemLoginCode({ code, cookieState: state, store: site.store })).toMatchObject({ ok: false });
    });
  });

  describe('wallet-initiated', () => {
    it('card_login §AC: a request echoing the pending wallet_nonce skips the prompt', async () => {
      const pending = createInMemoryPendingWalletLoginStore();
      const { openUrl } = await startWalletInitiatedLogin({ startUrl: `${w.origin}/login/start`, store: pending, walletAppCard: w.appRoot.address });
      const { walletNonce } = parseWalletStart(openUrl);
      const site = createSite(w);
      const { url } = await site.issue('form_post', { walletNonce: walletNonce! });
      const { validated, matches } = await walletRespond(w, site, url);
      expect(await shouldSkipPrompt({ validated, matches, store: pending })).toEqual({ skip: true, card: w.user.address });
    });

    it('card_login §AC: the same request without a pending login shows the prompt', async () => {
      const site = createSite(w);
      const { url } = await site.issue('form_post', { walletNonce: 'n'.repeat(22) });
      const { validated, matches } = await walletRespond(w, site, url);
      expect(await shouldSkipPrompt({ validated, matches, store: createInMemoryPendingWalletLoginStore() })).toEqual({ skip: false });
    });
  });

  describe('press: login service scope (press.md §5.4)', () => {
    const subDoc = (holder: { address: string; pubkey: string }, app: { address: string; pubkey: string }, attestation: string) => ({
      holder_primary_card: holder.address, holder_primary_card_pubkey: holder.pubkey,
      app_card: app.address, app_card_pubkey: app.pubkey,
      capabilities: ['text'], recipient_pubkey: bytesToBase64Url(crypto.getRandomValues(new Uint8Array(1312))),
      issued_at: new Date().toISOString(), attestation_level: attestation,
    });

    it('subcards §AC: a login service card as app for another card’s sub-card → P-26', async () => {
      expect(await registerSubCardRaw(subDoc(w.user, w.service, 'T2'), w.service.secretKey, w.user.secretKey)).toBe('P-26');
    });

    it('subcards §AC: S1 on an ordinary sub-card → P-27', async () => {
      expect(await registerSubCardRaw(subDoc(w.user, w.appRoot, 'S1'), w.appRoot.secretKey, w.user.secretKey)).toBe('P-27');
    });
  });

  describe('domain status (dns_resolution.md §7)', () => {
    it('card_login §AC: a monitored domain warns; a suspended domain blocks with DOMAIN_SUSPENDED; restoring clears both', async () => {
      const dns = dnsOptions();
      await flagDomainFraudRisk({ ...dns, domain: w.domain, fraudRisk: 1, suspensionExpiresAt: 0n });
      expect(await w.verifier.verifyServerCard(w.server.pubkey, { origin: w.origin })).toMatchObject({ valid: true, warnings: ['LOGIN_WARN_DOMAIN_MONITORED'] });

      await flagDomainFraudRisk({ ...dns, domain: w.domain, fraudRisk: 2, suspensionExpiresAt: BigInt(Math.floor(Date.now() / 1000) + 365 * 86400) });
      expect(await w.verifier.verifyServerCard(w.server.pubkey, { origin: w.origin })).toMatchObject({ valid: false, code: 'DOMAIN_SUSPENDED' });

      await flagDomainFraudRisk({ ...dns, domain: w.domain, fraudRisk: 0, suspensionExpiresAt: 0n });
      expect(await w.verifier.verifyServerCard(w.server.pubkey, { origin: w.origin })).toMatchObject({ valid: true, warnings: [] });
    }, 300_000);
  });

  describe('revocation (runs last: it ends this world’s login service)', () => {
    it('card_login §AC: a revoked login service card blocks the login → LOGIN_SERVICE_REVOKED', async () => {
      await postCardUpdate({
        transport: directTransport,
        pressBaseUrl: PRESS_BASE_URL,
        intent: {
          target_card: w.service.address,
          updater_card: w.service.address,
          code: 801,
          revocation: { effective_date: new Date(Date.now() - 1000).toISOString(), note: 'integration test: login service retired' },
          timestamp: new Date().toISOString(),
          notify_holder: false,
        },
        sign: (m) => mlDsa44Sign(w.service.secretKey, m),
        signerPublicKey: w.service.pubkey,
      });
      expect(await w.verifier.verifyServerCard(w.server.pubkey, { origin: w.origin })).toMatchObject({ valid: false, code: 'LOGIN_SERVICE_REVOKED' });
    }, 300_000);
  });
});
