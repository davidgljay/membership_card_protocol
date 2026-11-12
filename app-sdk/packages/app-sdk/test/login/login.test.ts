// app_sdk.md §9a — site-side card login. Trust decisions are delegated to the
// verifier (tested there); this file stubs verifyLoginResponse and tests the
// site-side state machine: request issuance, form_post, mcard_message, codes.
import { describe, it, expect, vi } from 'vitest';
import type { CardVerifier, LoginVerificationResult } from '@membership-card-protocol/verifier';
import {
  createLoginRequest,
  serveLoginRequest,
  createServerCardRequest,
  createInMemoryLoginStore,
  handleFormPost,
  handleLoginMessage,
  redeemLoginCode,
  loginStatus,
  generateLoginCode,
  normalizeLoginCode,
  stateCookie,
  readStateCookie,
  routerLoginUrl,
  crossDeviceLink,
  parseWalletStart,
  buildLoginServiceMetadata,
  type ServerCardIdentity,
} from '../../src/login/index.js';
import { createDevSecureKeyProvider } from '../../src/testing/index.js';
import { canonicalize } from '../../src/crypto/canonicalize.js';
import { mlDsa44Verify } from '../../src/crypto/index.js';
import { base64UrlToBytes, bytesToBase64Url } from '../../src/util/base64url.js';
import type { CardMessageEnvelope } from '../../src/messaging/envelope.js';

const ORIGIN = 'https://forum.example.org';
const NOW = new Date('2026-11-09T12:00:00Z');
const PRESENTED = 'cc'.repeat(32);
const SERVICE = 'dd'.repeat(32);

async function setup(verdict: LoginVerificationResult = { valid: true, presented_card: PRESENTED, login_service_card: SERVICE, matched_policy: 'p', verification: {} as never }) {
  const keyProvider = createDevSecureKeyProvider();
  const { server } = await createServerCardRequest({ loginServiceCard: SERVICE, loginServiceCardPubkey: 'svc-pk', keyProvider, keyId: 'server' });
  const store = createInMemoryLoginStore();
  const verifier = {
    verifyLoginResponse: vi.fn().mockResolvedValue(verdict),
    verifyEnvelope: vi.fn().mockResolvedValue({ signatures: [{ signature_valid: true }] }),
  } as unknown as CardVerifier;
  const issue = (responseMode: 'form_post' | 'mcard_message' = 'form_post', extra = {}) =>
    createLoginRequest({ server, keyProvider, store, policies: [{ id: 'aa'.repeat(32), include_children: true }], responseMode, responseUri: `${ORIGIN}/login/cb`, purpose: 'Log in', now: NOW, ...extra });
  return { keyProvider, server, store, verifier, issue };
}

const authResponseB64 = (state: string) =>
  bytesToBase64Url(new TextEncoder().encode(JSON.stringify({ payload: { type: 'auth_response', content: { state } }, signatures: [] })));

describe('§9a.1 createServerCardRequest', () => {
  it('builds an S1 server card document with the login service card as app and holder', async () => {
    const { unsignedDocument, server } = await createServerCardRequest({ loginServiceCard: SERVICE, loginServiceCardPubkey: 'svc-pk', keyProvider: createDevSecureKeyProvider(), keyId: 'k' });
    expect(unsignedDocument).toMatchObject({ holder_primary_card: SERVICE, app_card: SERVICE, attestation_level: 'S1', capabilities: ['auth_request', 'auth_confirmation', 'error'] });
    expect(unsignedDocument.recipient_pubkey).toBe(server.pubkey);
    expect(server.pointer).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('§9a.2 createLoginRequest / serveLoginRequest', () => {
  it('issues a v2 request signed by the server card, with the default statement', async () => {
    const { issue, server } = await setup();
    const { request, state } = await issue();
    expect(request).toMatchObject({ version: '2', response_mode: 'form_post', requester_card: server.pointer, state, statement: `Log in to ${ORIGIN}`, expires_at: '2026-11-09T12:05:00.000Z' });
    const { request_signature, ...unsigned } = request;
    expect(mlDsa44Verify(base64UrlToBytes(server.pubkey), canonicalize(unsigned), base64UrlToBytes(request_signature))).toBe(true);
  });

  it('copies wallet_nonce and context; rejects http response URIs, non-default ports, and long TTLs', async () => {
    const { issue } = await setup();
    const { request } = await issue('mcard_message', { walletNonce: 'w'.repeat(22), context: { a: 'b' } });
    expect(request).toMatchObject({ wallet_nonce: 'w'.repeat(22), context: { a: 'b' } });
    await expect(issue('form_post', { responseUri: 'http://forum.example.org/cb' })).rejects.toThrow(/https/);
    await expect(issue('form_post', { responseUri: 'https://forum.example.org:8443/cb' })).rejects.toThrow(/default port/);
    await expect(issue('form_post', { ttlSeconds: 601 })).rejects.toThrow(/ttlSeconds/);
  });

  it('card_login §AC: request_uri serves 200 while issued and 410 after completion or expiry', async () => {
    const { issue, store, verifier } = await setup();
    const { requestId, state } = await issue();
    expect((await serveLoginRequest(store, requestId, NOW)).status).toBe(200);
    expect((await serveLoginRequest(store, requestId, new Date('2026-11-09T12:06:00Z'))).status).toBe(410);
    await handleFormPost({ body: { state, auth_response: authResponseB64(state) }, cookieState: state, store, verifier, expectedOrigin: ORIGIN, now: NOW });
    expect((await serveLoginRequest(store, requestId, NOW)).status).toBe(410);
  });
});

describe('§9a.2 URL and cookie helpers', () => {
  it('state cookie is Secure, HttpOnly, SameSite=None, path-scoped, and readable back', () => {
    const c = stateCookie('abc_-1', '2026-11-09T12:05:00Z', '/login');
    expect(c).toContain('mcard_login_state=abc_-1');
    for (const part of ['Secure', 'HttpOnly', 'SameSite=None', 'Path=/login']) expect(c).toContain(part);
    expect(readStateCookie('x=1; mcard_login_state=abc_-1; y=2')).toBe('abc_-1');
  });
  it('router URL carries parameters only in the fragment', () => {
    const u = new URL(routerLoginUrl({ routerOrigin: 'https://router.example.com', requestUri: `${ORIGIN}/r/1`, walletHint: 'w', fallbackUri: `${ORIGIN}/qr` }));
    expect(u.search).toBe('');
    expect(new URLSearchParams(u.hash.slice(1)).get('request_uri')).toBe(`${ORIGIN}/r/1`);
  });
  it('cross-device link uses the mcard://auth action host; start URL parsing', () => {
    expect(crossDeviceLink(`${ORIGIN}/r/1`)).toBe(`mcard://auth?r=${encodeURIComponent(`${ORIGIN}/r/1`)}`);
    expect(parseWalletStart(`${ORIGIN}/start?wallet_nonce=${'n'.repeat(22)}&wallet_hint=w`)).toEqual({ walletNonce: 'n'.repeat(22), walletHint: 'w' });
    expect(parseWalletStart(`${ORIGIN}/start?wallet_nonce=short`)).toEqual({});
  });
});

describe('§9a.3 handleFormPost (card_login.md steps 23–24)', () => {
  it('card_login §AC: valid response with a matching cookie completes, bound to the presented card', async () => {
    const { issue, store, verifier } = await setup();
    const { state } = await issue();
    const r = await handleFormPost({ body: { state, auth_response: authResponseB64(state) }, cookieState: state, store, verifier, expectedOrigin: ORIGIN, now: NOW });
    expect(r).toMatchObject({ ok: true, presentedCard: PRESENTED });
    expect((await store.getPending(state))?.status).toBe('complete');
  });
  it('card_login §AC: same response from a browser without the cookie → LOGIN_SESSION_MISMATCH', async () => {
    const { issue, store, verifier } = await setup();
    const { state } = await issue();
    const r = await handleFormPost({ body: { state, auth_response: authResponseB64(state) }, cookieState: undefined, store, verifier, expectedOrigin: ORIGIN, now: NOW });
    expect(r).toMatchObject({ ok: false, code: 'LOGIN_SESSION_MISMATCH' });
  });
  it('a failed verification leaves the login usable; a second use is rejected', async () => {
    const bad = await setup({ valid: false, code: 'LOGIN_NONCE_MISMATCH', reason: 'x' });
    const { state } = await bad.issue();
    expect(await handleFormPost({ body: { state, auth_response: authResponseB64(state) }, cookieState: state, store: bad.store, verifier: bad.verifier, expectedOrigin: ORIGIN, now: NOW })).toMatchObject({ code: 'LOGIN_NONCE_MISMATCH' });
    expect((await bad.store.getPending(state))?.status).toBe('issued');

    const good = await setup();
    const g = await good.issue();
    const args = { body: { state: g.state, auth_response: authResponseB64(g.state) }, cookieState: g.state, store: good.store, verifier: good.verifier, expectedOrigin: ORIGIN, now: NOW };
    expect((await handleFormPost(args)).ok).toBe(true);
    expect(await handleFormPost(args)).toMatchObject({ ok: false, code: 'LOGIN_STATE_UNKNOWN' });
  });
  it('error=access_denied marks the login failed', async () => {
    const { issue, store, verifier } = await setup();
    const { state } = await issue();
    expect(await handleFormPost({ body: { state, error: 'access_denied' }, cookieState: state, store, verifier, expectedOrigin: ORIGIN, now: NOW })).toMatchObject({ ok: false, code: 'access_denied' });
    expect((await store.getPending(state))?.status).toBe('failed');
  });
});

describe('§9a.3 mcard_message + one-time code (card_login.md steps 24–27)', () => {
  async function respond() {
    const s = await setup();
    const { state } = await s.issue('mcard_message');
    const sent: CardMessageEnvelope<'auth_confirmation'>[] = [];
    const latency: number[] = [];
    const envelope = { payload: { type: 'auth_response', content: { state }, timestamp: '2026-11-09T11:59:58Z' }, signatures: [] } as unknown as CardMessageEnvelope<'auth_response'>;
    const r = await handleLoginMessage({
      envelope, messageId: 'msg-1', receivedAt: NOW, store: s.store, verifier: s.verifier, expectedOrigin: ORIGIN,
      server: s.server as ServerCardIdentity, loginServiceCard: SERVICE, keyProvider: s.keyProvider, protocolVersion: '0.1',
      sendConfirmation: async (_to, env) => void sent.push(env), onLatency: (x) => void latency.push(x.latencyMs),
    });
    return { ...s, state, sent, latency, r };
  }

  it('verifies, records latency, and sends auth_confirmation signed by the server card to the presented card', async () => {
    const { r, sent, latency, server } = await respond();
    expect(r.ok).toBe(true);
    expect(latency).toEqual([2000]);
    expect(sent).toHaveLength(1);
    const p = sent[0]!.payload;
    expect(p).toMatchObject({ type: 'auth_confirmation', recipients: [PRESENTED], senders: [SERVICE], in_reply_to: 'msg-1' });
    expect(p.content.code).toMatch(/^[0-9A-HJKMNP-TV-Z]{8}$/);
    expect(mlDsa44Verify(base64UrlToBytes(server.pubkey), canonicalize(p), base64UrlToBytes(sent[0]!.signatures[0]!.signature))).toBe(true);
  });

  it('card_login §AC: needs the cookie AND the code — either alone fails', async () => {
    const { store, state, sent } = await respond();
    const code = sent[0]!.payload.content.code;
    expect(await redeemLoginCode({ code, cookieState: undefined, store, now: NOW })).toMatchObject({ code: 'LOGIN_SESSION_MISMATCH' });
    expect(await redeemLoginCode({ code: 'WRONG000', cookieState: state, store, now: NOW })).toMatchObject({ code: 'LOGIN_CODE_INVALID' });
    expect(await redeemLoginCode({ code: code.toLowerCase(), cookieState: state, store, now: NOW })).toMatchObject({ ok: true, presentedCard: PRESENTED });
  });

  it('card_login §AC: a code works once; the fifth wrong attempt fails the login; expired codes fail', async () => {
    const a = await respond();
    const code = a.sent[0]!.payload.content.code;
    expect((await redeemLoginCode({ code, cookieState: a.state, store: a.store, now: NOW })).ok).toBe(true);
    expect((await redeemLoginCode({ code, cookieState: a.state, store: a.store, now: NOW })).ok).toBe(false);

    const b = await respond();
    for (let i = 0; i < 5; i++) await redeemLoginCode({ code: 'WRONG000', cookieState: b.state, store: b.store, now: NOW });
    expect((await b.store.getPending(b.state))?.status).toBe('failed');
    expect((await redeemLoginCode({ code: b.sent[0]!.payload.content.code, cookieState: b.state, store: b.store, now: NOW })).ok).toBe(false);

    const c = await respond();
    expect(await redeemLoginCode({ code: c.sent[0]!.payload.content.code, cookieState: c.state, store: c.store, now: new Date('2026-11-09T12:06:00Z') })).toMatchObject({ code: 'LOGIN_CODE_INVALID' });
  });

  it('card_login §AC: polling reports progress but never completes a login', async () => {
    const { store, state } = await respond();
    expect(await loginStatus(store, state)).toBe('responded');
    expect(await loginStatus(store, state)).toBe('responded');
  });

  it('codes are 8 Crockford characters; typing normalizes I/L/O and separators', () => {
    for (let i = 0; i < 50; i++) expect(generateLoginCode()).toMatch(/^[0-9A-HJKMNP-TV-Z]{8}$/);
    expect(normalizeLoginCode('ab1o-il 23')).toBe('AB10112' + '3');
  });
});

describe('§9a.4 buildLoginServiceMetadata', () => {
  it('signs the metadata body with the server card and rejects a start URL on another origin', async () => {
    const { server, keyProvider } = await setup();
    const doc = await buildLoginServiceMetadata({ origin: ORIGIN, name: 'Forum', startUrl: `${ORIGIN}/login/start`, accepts: [{ id: 'aa'.repeat(32), include_children: true }], responseModes: ['form_post'], server, keyProvider });
    expect(doc.metadata).toMatchObject({ origin: ORIGIN, server_card: server.pointer, version: '1' });
    expect(mlDsa44Verify(base64UrlToBytes(server.pubkey), canonicalize(doc.metadata), base64UrlToBytes(doc.signature))).toBe(true);
    await expect(buildLoginServiceMetadata({ origin: ORIGIN, name: 'F', startUrl: 'https://evil.example.net/s', accepts: [], responseModes: [], server, keyProvider })).rejects.toThrow(/same origin/);
  });
});
