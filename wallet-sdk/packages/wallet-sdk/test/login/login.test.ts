// wallet_sdk.md §7a — wallet-side card login. Chain/trust checks are the
// verifier's (tested there); verifyServerCard is stubbed here, and everything
// else uses real crypto.
import { describe, it, expect, vi } from 'vitest';
import {
  mlDsa44GenerateKeypair,
  mlDsa44Sign,
  mlDsa44Verify,
  canonicalize,
  keccak256,
  bytesToBase64Url,
  base64UrlToBytes,
  buildMessagePayload,
  signMessageEnvelope,
} from '@membership-card-protocol/app-sdk';
import { createDevSecureKeyProvider } from '@membership-card-protocol/app-sdk/testing';
import { checkDomainBindingSignature, requestHash, type CardVerifier, type AuthenticationRequest } from '@membership-card-protocol/verifier';
import {
  parseLoginHandoff,
  fetchAndValidateLoginRequest,
  createInMemoryPendingWalletLoginStore,
  startWalletInitiatedLogin,
  shouldSkipPrompt,
  buildLoginResponse,
  formPostFields,
  formRelayUrl,
  buildDecline,
  handleAuthConfirmation,
  authorizeServerCard,
  signDomainBindingAttestation,
  postDomainBinding,
  routerRegistrationUrl,
  signWalletRegistrationToken,
  resolveEffectiveServices,
  type ValidatedLoginRequest,
} from '../../src/login/index.js';
import { handleSubCardRequest } from '../../src/subcards/handleSubCardRequest.js';

const NOW = new Date('2026-11-09T12:00:00Z');
const ORIGIN = 'https://forum.example.org';
const kp = (b: number) => mlDsa44GenerateKeypair(new Uint8Array(32).fill(b));
const server = kp(0x81);
const service = kp(0x82);
const device = kp(0x83);
const b64 = (u: Uint8Array) => bytesToBase64Url(u);
const SERVICE_ADDR = keccak256(service.publicKey);
const USER_CARD = 'ab'.repeat(32);

function makeRequest(over: Partial<AuthenticationRequest> = {}, signer = server): AuthenticationRequest {
  const unsigned = {
    dcql_query: { credentials: [{ id: 'm', format: 'mcard' as const, meta: { policies: [{ id: 'aa'.repeat(32), include_children: true }] } }] },
    expires_at: '2026-11-09T12:05:00Z',
    nonce: 'n'.repeat(43),
    purpose: 'Log in',
    requester_card: keccak256(server.publicKey),
    requester_pubkey: b64(server.publicKey),
    response_mode: 'form_post' as const,
    response_uri: `${ORIGIN}/login/cb`,
    state: 's'.repeat(22),
    statement: `Log in to ${ORIGIN}`,
    version: '2' as const,
    ...over,
  };
  const { request_signature: _x, ...toSign } = unsigned as AuthenticationRequest;
  return { ...toSign, request_signature: b64(mlDsa44Sign(signer.secretKey, canonicalize(toSign))) } as AuthenticationRequest;
}

function verifierStub(verdict: 'valid' | 'invalid' = 'valid', warnings: string[] = []): CardVerifier {
  return {
    verifyServerCard: vi.fn().mockResolvedValue(
      verdict === 'valid'
        ? { valid: true, server_card: keccak256(server.publicKey), login_service_card: SERVICE_ADDR, login_service_card_pubkey: b64(service.publicKey), domain: 'example.org', login_service: {}, warnings }
        : { valid: false, code: 'LOGIN_ORIGIN_NOT_BOUND', reason: 'x' }
    ),
  } as unknown as CardVerifier;
}
const fetchJson = (body: unknown, status = 200) => vi.fn().mockResolvedValue({ status, json: async () => body }) as unknown as typeof fetch;

async function validated(over: Partial<AuthenticationRequest> = {}, warnings: string[] = []): Promise<ValidatedLoginRequest> {
  const r = await fetchAndValidateLoginRequest({ handoff: { requestUri: `${ORIGIN}/r/1`, via: 'router' }, verifier: verifierStub('valid', warnings), fetch: fetchJson(makeRequest(over)), now: NOW });
  if (!r.valid) throw new Error(r.code);
  return r;
}

describe('§7a.1 parseLoginHandoff', () => {
  it('reads the router fragment, a deep link, and a scanned QR', () => {
    expect(parseLoginHandoff({ url: `https://wallet.example.net/login#request_uri=${encodeURIComponent(`${ORIGIN}/r/1`)}` })).toEqual({ requestUri: `${ORIGIN}/r/1`, via: 'router' });
    expect(parseLoginHandoff({ url: `mcard://auth?r=${encodeURIComponent(`${ORIGIN}/r/1`)}` })).toEqual({ requestUri: `${ORIGIN}/r/1`, via: 'deeplink' });
    expect(parseLoginHandoff({ url: `mcard://auth?r=${encodeURIComponent(`${ORIGIN}/r/1`)}`, scanned: true })).toMatchObject({ via: 'qr' });
  });
  it('dns_resolution §AC: mcard://auth is an action link, never a CID or domain; other forms are rejected', () => {
    expect(parseLoginHandoff({ url: 'mcard://bafyrei123/x' })).toEqual({ error: 'LOGIN_REQUEST_MALFORMED' });
    expect(parseLoginHandoff({ url: 'mcard://auth?r=http%3A%2F%2Fx.org' })).toEqual({ error: 'LOGIN_REQUEST_MALFORMED' });
  });
});

describe('§7a.2 fetchAndValidateLoginRequest (card_login.md steps 10–16)', () => {
  const run = (body: unknown, verifier = verifierStub(), status = 200) =>
    fetchAndValidateLoginRequest({ handoff: { requestUri: `${ORIGIN}/r/1`, via: 'router' }, verifier, fetch: fetchJson(body, status), now: NOW });

  it('valid request → valid with origin, hash, and the login service card', async () => {
    const request = makeRequest();
    const r = await run(request);
    expect(r).toMatchObject({ valid: true, origin: ORIGIN, requestHash: requestHash(request) });
  });
  it.each([
    ['non-200 → LOGIN_REQUEST_UNAVAILABLE', () => run({}, verifierStub(), 410), 'LOGIN_REQUEST_UNAVAILABLE'],
    ['card_login §AC: unknown version → LOGIN_REQUEST_MALFORMED', () => run(makeRequest({ version: '1' as never })), 'LOGIN_REQUEST_MALFORMED'],
    ['card_login §AC: two credentials → LOGIN_REQUEST_MALFORMED', () => run(makeRequest({ dcql_query: { credentials: [makeRequest().dcql_query.credentials[0]!, makeRequest().dcql_query.credentials[0]!] } })), 'LOGIN_REQUEST_MALFORMED'],
    ['http response_uri → LOGIN_REQUEST_MALFORMED', () => run(makeRequest({ response_uri: 'http://forum.example.org/cb' })), 'LOGIN_REQUEST_MALFORMED'],
    ['card_login §AC: expired → LOGIN_REQUEST_EXPIRED', () => run(makeRequest({ expires_at: '2026-11-09T11:59:00Z' })), 'LOGIN_REQUEST_EXPIRED'],
    ['expires too far ahead → LOGIN_REQUEST_EXPIRED', () => run(makeRequest({ expires_at: '2026-11-09T13:00:00Z' })), 'LOGIN_REQUEST_EXPIRED'],
    ['card_login §AC: pubkey/pointer mismatch → LOGIN_REQUESTER_BINDING_MISMATCH', () => run(makeRequest({ requester_card: 'ff'.repeat(32) })), 'LOGIN_REQUESTER_BINDING_MISMATCH'],
    ['card_login §AC: bad signature → LOGIN_REQUEST_SIGNATURE_INVALID', () => run({ ...makeRequest(), purpose: 'changed' }), 'LOGIN_REQUEST_SIGNATURE_INVALID'],
    ['server card rejected by the verifier → its code', () => run(makeRequest(), verifierStub('invalid')), 'LOGIN_ORIGIN_NOT_BOUND'],
  ])('%s', async (_label, call, code) => {
    expect(await call()).toMatchObject({ valid: false, code });
  });
});

describe('§7a.3 wallet-initiated shortcut (card_login.md step 18)', () => {
  async function scenario(opts: { warnings?: string[]; matches?: number; originOverride?: string; expire?: boolean; reuse?: boolean } = {}) {
    const store = createInMemoryPendingWalletLoginStore();
    const { walletNonce, openUrl } = await startWalletInitiatedLogin({ startUrl: `${opts.originOverride ?? ORIGIN}/login/start`, store, walletAppCard: 'wallet-card', now: NOW });
    expect(new URL(openUrl).searchParams.get('wallet_nonce')).toBe(walletNonce);
    const v = await validated({ wallet_nonce: walletNonce }, opts.warnings ?? []);
    const matches = Array.from({ length: opts.matches ?? 1 }, (_, i) => ({ card: `card${i}` }));
    const at = opts.expire ? new Date('2026-11-09T12:03:00Z') : NOW;
    if (opts.reuse) await shouldSkipPrompt({ validated: v, matches, store, now: at });
    return shouldSkipPrompt({ validated: v, matches, store, now: at });
  }
  it('card_login §AC: matching pending login, no warnings, one card → no prompt', async () => {
    expect(await scenario()).toEqual({ skip: true, card: 'card0' });
  });
  it.each([
    ['a warning', { warnings: ['LOGIN_WARN_SERVICE_NEGATIVE'] }],
    ['two matching cards', { matches: 2 }],
    ['a different origin', { originOverride: 'https://other.example.org' }],
    ['an expired pending login', { expire: true }],
    ['a pending login already used', { reuse: true }],
  ])('card_login §AC: prompt shown with %s', async (_l, opts) => {
    expect(await scenario(opts)).toEqual({ skip: false });
  });
});

describe('§7a.4 buildLoginResponse / form_post / decline', () => {
  const signer = { publicKey: device.publicKey, sign: (m: Uint8Array) => mlDsa44Sign(device.secretKey, m) };
  it('builds the v2 auth_response addressed to the login service card and signed by the device sub-card', async () => {
    const v = await validated();
    const { response, envelope } = await buildLoginResponse({ validated: v, presentedCard: USER_CARD, signer, protocolVersion: '0.1', now: NOW });
    expect(envelope.payload).toMatchObject({
      type: 'auth_response', recipients: [SERVICE_ADDR], senders: [USER_CARD],
      content: { audience: ORIGIN, nonce: v.request.nonce, request_hash: v.requestHash, state: v.request.state, statement: v.request.statement },
    });
    expect(mlDsa44Verify(device.publicKey, canonicalize(envelope.payload), base64UrlToBytes(envelope.signatures[0]!.signature))).toBe(true);
    const post = formPostFields(v.request, response);
    expect(post.action).toBe(`${ORIGIN}/login/cb`);
    expect(JSON.parse(new TextDecoder().decode(base64UrlToBytes(post.fields.auth_response!)))).toEqual(envelope);
    expect(new URL(formRelayUrl('https://wallet.example.net/relay', post)).hash).toContain('auth_response=');
  });
  it('declines: form_post posts error=access_denied; mcard_message signs an error message', async () => {
    expect(await buildDecline({ validated: await validated() })).toMatchObject({ mode: 'form_post', fields: { error: 'access_denied' } });
    const d = await buildDecline({ validated: await validated({ response_mode: 'mcard_message' }), presentedCard: USER_CARD, signer, protocolVersion: '0.1' });
    expect(d).toMatchObject({ mode: 'mcard_message', envelope: { payload: { type: 'error', content: { code: 'access_denied' } } } });
  });
});

describe('§7a.5 handleAuthConfirmation (card_login.md step 25)', () => {
  async function confirmation(v: ValidatedLoginRequest, over: { code?: string; inReplyTo?: string; hash?: string; signer?: ReturnType<typeof kp> } = {}) {
    const payload = buildMessagePayload({
      type: 'auth_confirmation',
      content: { code: over.code ?? 'ABCD2345', expires_at: '2026-11-09T12:05:00Z', request_hash: over.hash ?? v.requestHash },
      recipients: [USER_CARD], senders: [SERVICE_ADDR], protocolVersion: '0.1', inReplyTo: over.inReplyTo ?? 'resp-1',
    });
    const s = over.signer ?? server;
    return signMessageEnvelope(payload, [{ publicKey: s.publicKey, sign: (m) => mlDsa44Sign(s.secretKey, m) }]);
  }
  it('same device → open response_uri?code=; QR → show the code', async () => {
    const v = await validated({ response_mode: 'mcard_message' });
    const env = await confirmation(v);
    expect(handleAuthConfirmation({ envelope: env, sentResponseId: 'resp-1', validated: v, via: 'router', now: NOW })).toEqual({ ok: true, action: 'open', url: `${ORIGIN}/login/cb?code=ABCD2345` });
    expect(handleAuthConfirmation({ envelope: env, sentResponseId: 'resp-1', validated: v, via: 'qr', now: NOW })).toMatchObject({ ok: true, action: 'show', code: 'ABCD2345', origin: ORIGIN });
  });
  it.each([
    ['not our reply', { inReplyTo: 'other' }],
    ['different request', { hash: 'x' }],
    ['signed by someone else', { signer: device }],
    ['malformed code', { code: 'abc' }],
  ])('LOGIN_CONFIRMATION_INVALID: %s', async (_l, over) => {
    const v = await validated({ response_mode: 'mcard_message' });
    expect(handleAuthConfirmation({ envelope: await confirmation(v, over), sentResponseId: 'resp-1', validated: v, via: 'router', now: NOW })).toMatchObject({ ok: false, code: 'LOGIN_CONFIRMATION_INVALID' });
  });
});

describe('§7a.6 authorizeServerCard / §6.1 scope rule', () => {
  const unsigned = () => ({
    holder_primary_card: SERVICE_ADDR, holder_primary_card_pubkey: b64(service.publicKey),
    app_card: SERVICE_ADDR, app_card_pubkey: b64(service.publicKey),
    capabilities: ['auth_request', 'auth_confirmation', 'error'], recipient_pubkey: b64(server.publicKey),
    issued_at: NOW.toISOString(), attestation_level: 'S1' as const,
  });
  it('signs as app and holder with the login service card key, registers, and posts code 510', async () => {
    const registerSubCard = vi.fn().mockResolvedValue({ registered: true });
    const post = vi.fn().mockResolvedValue({});
    const r = await authorizeServerCard({ unsignedDocument: unsigned(), loginServiceCardSecretKey: service.secretKey, registerSubCard, postActiveSubcardAddition: post });
    expect(r.registered).toBe(true);
    if (!r.registered) return;
    const { app_signature, holder_signature, ...fields } = r.document;
    expect(mlDsa44Verify(service.publicKey, canonicalize(fields), base64UrlToBytes(app_signature))).toBe(true);
    expect(mlDsa44Verify(service.publicKey, canonicalize({ ...fields, app_signature }), base64UrlToBytes(holder_signature))).toBe(true);
    expect(post).toHaveBeenCalledWith(b64(server.publicKey));
  });
  it('refuses a document whose app_card is not its holder, or that is not S1', async () => {
    const reg = vi.fn();
    expect(await authorizeServerCard({ unsignedDocument: { ...unsigned(), holder_primary_card: 'ee'.repeat(32) }, loginServiceCardSecretKey: service.secretKey, registerSubCard: reg, postActiveSubcardAddition: vi.fn() })).toMatchObject({ registered: false, code: 'LOGIN_SERVICE_SCOPE' });
    expect(await authorizeServerCard({ unsignedDocument: { ...unsigned(), attestation_level: 'T2' as never }, loginServiceCardSecretKey: service.secretKey, registerSubCard: reg, postActiveSubcardAddition: vi.fn() })).toMatchObject({ registered: false });
    expect(reg).not.toHaveBeenCalled();
  });
  it('subcards §AC: the wallet refuses a login service card as app for a third-party sub-card request', async () => {
    const holder = kp(0x84);
    const doc = {
      holder_primary_card: keccak256(holder.publicKey), holder_primary_card_pubkey: b64(holder.publicKey),
      app_card: SERVICE_ADDR, app_card_pubkey: b64(service.publicKey),
      capabilities: ['text'], recipient_pubkey: b64(device.publicKey), issued_at: NOW.toISOString(), attestation_level: 'T2' as const,
    };
    const request = { ...doc, app_signature: b64(mlDsa44Sign(service.secretKey, canonicalize(doc))) };
    const cardVerifier = { verifyCard: vi.fn().mockResolvedValue({ chain_reaches_trusted_root: true, is_currently_valid: true, chain_card_addresses: [SERVICE_ADDR, 'b2'.repeat(32), 'a1'.repeat(32)] }) } as unknown as CardVerifier;
    expect(await handleSubCardRequest({ cardVerifier, request, loginServiceCertificationRoot: 'b2'.repeat(32) })).toMatchObject({ valid: false, code: 'LOGIN_SERVICE_SCOPE' });
    expect(await handleSubCardRequest({ cardVerifier, request })).toMatchObject({ valid: true });
  });
});

describe('domain binding and router registration', () => {
  it('signDomainBindingAttestation produces a binding the verifier accepts; postDomainBinding posts code 520', async () => {
    const admin = kp(0x85);
    const binding = signDomainBindingAttestation({ domain: 'Example.org.', adminCardSecretKey: admin.secretKey, adminCardPublicKey: b64(admin.publicKey), loginServiceCardPublicKey: b64(service.publicKey), issuedAt: NOW.toISOString() });
    expect(binding.domain).toBe('example.org');
    expect(checkDomainBindingSignature(binding, SERVICE_ADDR)).toMatchObject({ ok: true });
    const request = vi.fn().mockResolvedValue({ status: 200, body: new TextEncoder().encode(JSON.stringify({ log_entry_cid: 'c', new_log_head_cid: 'c' })) });
    await postDomainBinding({ transport: { request } as never, pressBaseUrl: 'https://press', binding, loginServiceCardSecretKey: service.secretKey, loginServiceCardPublicKey: b64(service.publicKey) });
    const body = JSON.parse(new TextDecoder().decode(request.mock.calls[0]![1].body));
    expect(body.update_intent).toMatchObject({ code: 520, target_card: SERVICE_ADDR, updater_card: SERVICE_ADDR, field_updates: [{ field: 'domain_binding', value: binding }] });
    expect(mlDsa44Verify(service.publicKey, canonicalize(body.update_intent), base64UrlToBytes(body.intent_signature.signature))).toBe(true);
  });
  it('routerRegistrationUrl carries a signed token in the fragment', async () => {
    const keyProvider = createDevSecureKeyProvider();
    const pk = await keyProvider.generateKey('wallet');
    const token = await signWalletRegistrationToken({ token: { app_card: keccak256(pk), app_card_pubkey: b64(pk), expires_at: '2027-01-01T00:00:00Z', handler_url: 'https://wallet.example.net/login', issued_at: NOW.toISOString(), name: 'W', router_origin: 'https://router.example.com' }, appCardKeyId: 'wallet', keyProvider });
    const url = new URL(routerRegistrationUrl({ routerOrigin: 'https://router.example.com', token, next: 'https://issuer.example.org/done' }));
    expect(url.pathname).toBe('/register');
    const params = new URLSearchParams(url.hash.slice(1));
    const decoded = JSON.parse(new TextDecoder().decode(base64UrlToBytes(params.get('token')!)));
    expect(decoded).toEqual(token);
    expect(mlDsa44Verify(pk, canonicalize(decoded.token), base64UrlToBytes(decoded.signature))).toBe(true);
    expect(params.get('next')).toBe('https://issuer.example.org/done');
  });
});

describe('§7a.8 resolveEffectiveServices', () => {
  it('keeps only listed services whose signed metadata is valid and accepts the card', async () => {
    const policyKp = kp(0x86);
    const policyAddr = keccak256(policyKp.publicKey);
    const snapshot = { recipient_pubkey: b64(policyKp.publicKey), ancestry_pubkeys: [], preferred_services: [
      { origin: ORIGIN, name: 'Forum (from policy)' },
      { origin: 'https://other.example.org', name: 'Other' },
    ] };
    const chain = {
      rpc: { getCardEntry: vi.fn().mockResolvedValue(null) } as never,
      ipfs: { fetch: vi.fn().mockResolvedValue(new TextEncoder().encode(JSON.stringify(snapshot))) },
    };
    const metaBody = (accepts: string) => ({
      accepts: [{ id: accepts, include_children: true }], name: 'Site name', origin: ORIGIN, response_modes: ['form_post'],
      server_card: keccak256(server.publicKey), server_card_pubkey: b64(server.publicKey), start_url: `${ORIGIN}/start`, updated_at: NOW.toISOString(), version: '1',
    });
    const signed = (body: object) => ({ metadata: body, signature: b64(mlDsa44Sign(server.secretKey, canonicalize(body))) });
    const fetchMock = vi.fn().mockImplementation(async (url: string) =>
      url.startsWith(ORIGIN) ? { status: 200, json: async () => signed(metaBody(policyAddr)) } : { status: 200, json: async () => signed({ ...metaBody(policyAddr), origin: 'https://other.example.org' }) }
    ) as unknown as typeof fetch;
    const services = await resolveEffectiveServices({ cardFields: { policy_id: 'bafypolicy' }, chain, verifier: verifierStub(), fetch: fetchMock, now: NOW });
    // The second service's metadata names a start_url on another origin, so it is dropped.
    expect(services.map((s) => s.name)).toEqual(['Forum (from policy)']);
  });
});

describe('offer acceptance → login router registration (card_login.md §Router Registration)', () => {
  it('returns a registration URL forwarding to next, unless already registered', async () => {
    const { registrationField } = await import('../../src/offers/loginRouterHook.js');
    const token = { token: { app_card: 'w', app_card_pubkey: 'pk', expires_at: '2027-01-01T00:00:00Z', handler_url: 'https://wallet.example.net/login', issued_at: NOW.toISOString(), name: 'W', router_origin: 'https://router.example.com', version: '1' as const }, signature: 'sig' };
    const r = registrationField({ routerOrigin: 'https://router.example.com', token, next: 'https://issuer.example.org/welcome' });
    expect(new URL(r.routerRegistrationUrl!).pathname).toBe('/register');
    expect(new URLSearchParams(new URL(r.routerRegistrationUrl!).hash.slice(1)).get('next')).toBe('https://issuer.example.org/welcome');
    expect(registrationField({ routerOrigin: 'https://router.example.com', token, alreadyRegistered: true })).toEqual({});
    expect(registrationField(undefined)).toEqual({});
  });
});
