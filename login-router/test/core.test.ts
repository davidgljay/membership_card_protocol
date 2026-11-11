// login_router.md — router logic (§3, §4, §5, §6, §7, §8). Browser behavior
// (forwarding, fragment removal, no network) is covered by test/e2e/.
import { describe, it, expect } from 'vitest';
import { ml_dsa44 } from '@noble/post-quantum/ml-dsa.js';
import { canonicalize } from '@membership-card-protocol/verifier';
import { readFileSync } from 'node:fs';
import {
  parseStorage,
  withoutDelisted,
  parseLoginFragment,
  decideLogin,
  parseRegisterFragment,
  validateToken,
  registerWallet,
  setDefault,
  removeWallet,
  addressLookupUrl,
  walletsForPlatform,
  type CertifiedWallet,
  type WalletRegistrationToken,
  type WalletRegistrationTokenBody,
} from '../src/core.js';

const ROUTER = 'https://router.example.com';
const NOW = new Date('2026-11-09T12:00:00Z');
const b64 = (u: Uint8Array) => Buffer.from(u).toString('base64url');
const kp = (b: number) => ml_dsa44.keygen(new Uint8Array(32).fill(b));
const W1 = kp(1);
const W2 = kp(2);
const ROGUE = kp(3);
const addr = (k: { publicKey: Uint8Array }) => b64(k.publicKey).slice(0, 8);

const certified: CertifiedWallet[] = [W1, W2].map((k, i) => ({
  app_card: addr(k), app_card_pubkey: b64(k.publicKey), name: `Wallet ${i + 1}`, handler_url: `https://w${i + 1}.example.net/login`, platforms: ['web'],
}));

function token(k: ReturnType<typeof kp>, over: Partial<WalletRegistrationTokenBody> = {}, signer = k): WalletRegistrationToken {
  const body: WalletRegistrationTokenBody = {
    app_card: addr(k), app_card_pubkey: b64(k.publicKey), expires_at: '2027-06-01T00:00:00Z', handler_url: `https://${addr(k)}.example.net/login`,
    issued_at: '2026-11-01T00:00:00Z', name: `Wallet ${addr(k)}`, router_origin: ROUTER, version: '1', ...over,
  };
  return { token: body, signature: b64(ml_dsa44.sign(canonicalize(body), signer.secretKey)) };
}
const fragmentFor = (t: WalletRegistrationToken, next?: string) =>
  '#' + new URLSearchParams({ token: b64(canonicalize(t)), ...(next ? { next } : {}) }).toString();
const REQ = 'https://forum.example.org/login/r/abc';

describe('§5 token validation (shared login-conformance vector + local cases)', () => {
  const vectors = JSON.parse(readFileSync(new URL('../../specs/login-conformance.json', import.meta.url), 'utf-8'));
  for (const c of vectors.signatures.filter((x: { kind: string }) => x.kind === 'WalletRegistrationToken')) {
    it(`${c.id}: ${c.description}`, () => {
      const list: CertifiedWallet[] = [{ app_card: c.object.token.app_card, app_card_pubkey: c.public_key, name: 'x', handler_url: 'https://x.example', platforms: ['web'] }];
      const r = validateToken(c.object, list, c.object.token.router_origin === 'https://router.example.com' ? 'https://router.example.com' : 'https://router.example.com', NOW);
      expect(r.ok).toBe(c.expected_valid);
    });
  }
  it('accepts a valid token from a certified wallet', () => expect(validateToken(token(W1), certified, ROUTER, NOW).ok).toBe(true));
  it.each([
    ['login_router §AC: wallet not on the certified list', () => token(ROGUE)],
    ['login_router §AC: wrong router_origin', () => token(W1, { router_origin: 'https://other-router.example.com' })],
    ['login_router §AC: expired', () => token(W1, { expires_at: '2026-11-01T00:00:00Z' })],
    ['login_router §AC: bad signature', () => token(W1, {}, ROGUE)],
    ['lifetime over one year', () => token(W1, { issued_at: '2025-01-01T00:00:00Z' })],
    ['handler_url with a fragment', () => token(W1, { handler_url: 'https://w.example.net/login#x' })],
    ['pubkey differs from the certified list', () => token(W1, { app_card_pubkey: b64(W2.publicKey) }, W2)],
  ])('rejects: %s', (_l, make) => expect(validateToken(make(), certified, ROUTER, NOW).ok).toBe(false));
});

describe('§4 /register — add-only', () => {
  it('login_router §AC: first registration becomes the default', () => {
    const s = registerWallet(parseStorage(null), token(W1).token, NOW);
    expect(s.default).toBe(addr(W1));
    expect(s.wallets).toHaveLength(1);
  });
  it('login_router §AC: a second wallet is added without replacing the default', () => {
    const s = registerWallet(registerWallet(parseStorage(null), token(W1).token, NOW), token(W2).token, NOW);
    expect(s.default).toBe(addr(W1));
    expect(s.wallets.map((w) => w.app_card)).toEqual([addr(W1), addr(W2)]);
  });
  it('re-registering updates details only with a newer token, and never moves the default', () => {
    const base = registerWallet(registerWallet(parseStorage(null), token(W1).token, NOW), token(W2).token, NOW);
    const older = registerWallet(base, token(W2, { name: 'Old name', issued_at: '2026-10-01T00:00:00Z' }).token, NOW);
    expect(older.wallets[1]!.name).toBe(`Wallet ${addr(W2)}`);
    const newer = registerWallet(base, token(W2, { name: 'New name', issued_at: '2026-11-05T00:00:00Z' }).token, NOW);
    expect(newer.wallets[1]!.name).toBe('New name');
    expect(newer.default).toBe(addr(W1));
  });
  it('parses token and next from the fragment; drops non-https next', () => {
    const t = token(W1);
    expect(parseRegisterFragment(fragmentFor(t, 'https://issuer.example.org/done'))).toEqual({ token: t, next: 'https://issuer.example.org/done' });
    expect(parseRegisterFragment(fragmentFor(t, 'javascript:alert(1)'))).toEqual({ token: t });
  });
});

describe('§3 /login — choosing a wallet', () => {
  const one = registerWallet(parseStorage(null), token(W1).token, NOW);
  const two = registerWallet(one, token(W2).token, NOW);
  const params = (extra: Record<string, string> = {}) => {
    const p = parseLoginFragment('#' + new URLSearchParams({ request_uri: REQ, ...extra }).toString());
    if ('error' in p) throw new Error('bad');
    return p;
  };
  it('login_router §AC: one wallet → forward to handler_url#request_uri=…', () => {
    const d = decideLogin(params(), one);
    expect(d).toMatchObject({ kind: 'forward' });
    if (d.kind === 'forward') expect(new URLSearchParams(new URL(d.url).hash.slice(1)).get('request_uri')).toBe(REQ);
  });
  it('login_router §AC: two wallets → picker with the default first; wallet_hint bypasses it', () => {
    const d = decideLogin(params(), setDefault(two, addr(W2)));
    expect(d.kind === 'picker' && d.wallets.map((w) => w.app_card)).toEqual([addr(W2), addr(W1)]);
    expect(decideLogin(params({ wallet_hint: addr(W1) }), two)).toMatchObject({ kind: 'forward', wallet: { app_card: addr(W1) } });
  });
  it('login_router §AC: no wallet → recovery; "use my phone" only with fallback_uri', () => {
    expect(decideLogin(params(), parseStorage(null))).toEqual({ kind: 'recovery', showUseMyPhone: false });
    expect(decideLogin(params({ fallback_uri: 'https://forum.example.org/qr' }), parseStorage(null))).toEqual({ kind: 'recovery', showUseMyPhone: true });
  });
  it('a missing or non-https request_uri is a broken link', () => {
    expect(parseLoginFragment('')).toEqual({ error: 'broken_link' });
    expect(parseLoginFragment('#request_uri=http%3A%2F%2Fx.org')).toEqual({ error: 'broken_link' });
  });
  it('login_router §AC: a wallet removed from the certified list is no longer offered', () => {
    const pruned = withoutDelisted(two, certified.filter((c) => c.app_card !== addr(W1)));
    expect(pruned.wallets.map((w) => w.app_card)).toEqual([addr(W2)]);
    expect(pruned.default).toBeUndefined();
  });
});

describe('§7 storage and §8 settings', () => {
  it('unparseable or unknown-version storage is discarded', () => {
    expect(parseStorage('{nope')).toEqual({ version: 1, wallets: [] });
    expect(parseStorage(JSON.stringify({ version: 2, wallets: [] }))).toEqual({ version: 1, wallets: [] });
  });
  it('login_router §AC: the default changes only through setDefault (the settings page)', () => {
    const two = registerWallet(registerWallet(parseStorage(null), token(W1).token, NOW), token(W2).token, NOW);
    expect(setDefault(two, addr(W2)).default).toBe(addr(W2));
    expect(setDefault(two, 'unknown').default).toBe(addr(W1));
    expect(removeWallet(two, addr(W1))).toMatchObject({ default: addr(W2), wallets: [{ app_card: addr(W2) }] });
  });
});

describe('§6 recovery helpers', () => {
  it('address lookup builds the .well-known URL and rejects junk', () => {
    expect(addressLookupUrl(' https://MyWallet.example/path ')).toBe('https://mywallet.example/.well-known/membership-wallet');
    expect(addressLookupUrl('not a domain')).toBeNull();
  });
  it('wallet list is filtered to the platform (web wallets always shown)', () => {
    const list: CertifiedWallet[] = [
      { app_card: 'a', app_card_pubkey: 'p', name: 'iOS only', handler_url: 'https://a.example', platforms: ['ios'] },
      { app_card: 'b', app_card_pubkey: 'p', name: 'Web', handler_url: 'https://b.example', platforms: ['web'] },
    ];
    expect(walletsForPlatform(list, 'android').map((w) => w.name)).toEqual(['Web']);
    expect(walletsForPlatform(list, 'ios').map((w) => w.name)).toEqual(['iOS only', 'Web']);
  });
});
