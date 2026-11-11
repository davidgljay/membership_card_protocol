/**
 * Login router logic (specs/object_specs/login_router.md). Pure functions —
 * no DOM, no storage, no network — so every rule here is unit-testable; the
 * page scripts (src/pages.ts) only read the URL, call these, and render.
 */
import { canonicalize, mlDsa44Verify } from '@membership-card-protocol/verifier';

// ─── Types ───────────────────────────────────────────────────────────────────

/** One entry of the build-time certified wallet list (§5). */
export interface CertifiedWallet {
  app_card: string;
  app_card_pubkey: string;
  name: string;
  icon?: string;
  handler_url: string;
  platforms: ('web' | 'ios' | 'android')[];
  store_urls?: Record<string, string>;
}

/** A wallet stored in the router's localStorage (§7). */
export interface StoredWallet {
  app_card: string;
  name: string;
  icon?: string;
  handler_url: string;
  registered_at: string;
  token_issued_at: string;
}

export interface RouterStorage {
  version: 1;
  default?: string;
  wallets: StoredWallet[];
}

export interface WalletRegistrationTokenBody {
  app_card: string;
  app_card_pubkey: string;
  expires_at: string;
  handler_url: string;
  icon?: string;
  issued_at: string;
  name: string;
  router_origin: string;
  version: '1';
}
export interface WalletRegistrationToken {
  token: WalletRegistrationTokenBody;
  signature: string;
}

export const STORAGE_KEY = 'mcard-router:v1';
export const EMPTY_STORAGE: RouterStorage = { version: 1, wallets: [] };

// ─── Encoding ────────────────────────────────────────────────────────────────

export function base64UrlToBytes(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
  const bin = atob(b64);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

const norm = (a: string) => a.toLowerCase().replace(/^0x/, '');

function isHttpsUrl(s: unknown, opts: { noFragment?: boolean } = {}): s is string {
  if (typeof s !== 'string') return false;
  try {
    const u = new URL(s);
    return u.protocol === 'https:' && !(opts.noFragment && u.hash);
  } catch {
    return false;
  }
}

// ─── Storage (§7) ────────────────────────────────────────────────────────────

/** Parses stored state; anything unparseable or of an unknown version is discarded. */
export function parseStorage(raw: string | null | undefined): RouterStorage {
  if (!raw) return { ...EMPTY_STORAGE, wallets: [] };
  try {
    const v = JSON.parse(raw) as Partial<RouterStorage>;
    if (v.version !== 1 || !Array.isArray(v.wallets)) return { ...EMPTY_STORAGE, wallets: [] };
    const wallets = v.wallets.filter(
      (w): w is StoredWallet => !!w && typeof w.app_card === 'string' && typeof w.name === 'string' && isHttpsUrl(w.handler_url, { noFragment: true })
    );
    const def = typeof v.default === 'string' && wallets.some((w) => w.app_card === v.default) ? v.default : undefined;
    return { version: 1, wallets, ...(def ? { default: def } : {}) };
  } catch {
    return { ...EMPTY_STORAGE, wallets: [] };
  }
}

/** §3 step 2: wallets no longer on the certified list are dropped. */
export function withoutDelisted(storage: RouterStorage, certified: CertifiedWallet[]): RouterStorage {
  const listed = new Set(certified.map((c) => norm(c.app_card)));
  const wallets = storage.wallets.filter((w) => listed.has(norm(w.app_card)));
  const def = storage.default && wallets.some((w) => w.app_card === storage.default) ? storage.default : undefined;
  return { version: 1, wallets, ...(def ? { default: def } : {}) };
}

// ─── /login (§3) ─────────────────────────────────────────────────────────────

export interface LoginParams {
  requestUri: string;
  walletHint?: string;
  fallbackUri?: string;
}

export function parseLoginFragment(hash: string): LoginParams | { error: 'broken_link' } {
  const p = new URLSearchParams(hash.replace(/^#/, ''));
  const requestUri = p.get('request_uri');
  if (!isHttpsUrl(requestUri)) return { error: 'broken_link' };
  const walletHint = p.get('wallet_hint') ?? undefined;
  const fallbackUri = p.get('fallback_uri');
  return { requestUri, ...(walletHint ? { walletHint } : {}), ...(isHttpsUrl(fallbackUri) ? { fallbackUri } : {}) };
}

export type LoginDecision =
  | { kind: 'forward'; url: string; wallet: StoredWallet }
  | { kind: 'picker'; wallets: StoredWallet[] }
  | { kind: 'recovery'; showUseMyPhone: boolean };

/** The URL a wallet is opened at: handler_url#request_uri=… */
export function walletUrl(wallet: { handler_url: string }, requestUri: string): string {
  return `${wallet.handler_url}#${new URLSearchParams({ request_uri: requestUri }).toString()}`;
}

/** §3 step 3: hint → single wallet → picker (default first) → recovery. */
export function decideLogin(params: LoginParams, storage: RouterStorage): LoginDecision {
  const { wallets } = storage;
  if (params.walletHint) {
    const hinted = wallets.find((w) => norm(w.app_card) === norm(params.walletHint!));
    if (hinted) return { kind: 'forward', url: walletUrl(hinted, params.requestUri), wallet: hinted };
  }
  if (wallets.length === 1) return { kind: 'forward', url: walletUrl(wallets[0]!, params.requestUri), wallet: wallets[0]! };
  if (wallets.length > 1) {
    const def = wallets.find((w) => w.app_card === storage.default);
    return { kind: 'picker', wallets: def ? [def, ...wallets.filter((w) => w !== def)] : wallets };
  }
  return { kind: 'recovery', showUseMyPhone: !!params.fallbackUri };
}

// ─── Token validation (§5) ───────────────────────────────────────────────────

export type TokenCheck = { ok: true; token: WalletRegistrationTokenBody } | { ok: false; reason: string };

const MAX_TOKEN_LIFETIME_MS = 366 * 24 * 3600 * 1000;

export function validateToken(
  t: WalletRegistrationToken | undefined,
  certified: CertifiedWallet[],
  routerOrigin: string,
  now: Date
): TokenCheck {
  const b = t?.token;
  if (!b || typeof t?.signature !== 'string') return { ok: false, reason: 'malformed token' };
  if (b.version !== '1') return { ok: false, reason: 'unknown token version' };
  for (const f of ['app_card', 'app_card_pubkey', 'expires_at', 'handler_url', 'issued_at', 'name', 'router_origin'] as const) {
    if (typeof b[f] !== 'string' || !b[f]) return { ok: false, reason: `token.${f} missing` };
  }
  const listed = certified.find((c) => norm(c.app_card) === norm(b.app_card));
  if (!listed) return { ok: false, reason: 'wallet is not on the certified wallet list' };
  if (listed.app_card_pubkey !== b.app_card_pubkey) return { ok: false, reason: 'app_card_pubkey does not match the certified list' };
  let sigOk = false;
  try {
    sigOk = mlDsa44Verify(base64UrlToBytes(b.app_card_pubkey), canonicalize(b), base64UrlToBytes(t!.signature));
  } catch {
    sigOk = false;
  }
  if (!sigOk) return { ok: false, reason: 'signature does not verify' };
  if (b.router_origin !== routerOrigin) return { ok: false, reason: 'token is for a different router' };
  const issued = Date.parse(b.issued_at);
  const expires = Date.parse(b.expires_at);
  if (Number.isNaN(expires) || expires <= now.getTime()) return { ok: false, reason: 'token expired' };
  if (Number.isNaN(issued) || expires - issued > MAX_TOKEN_LIFETIME_MS) return { ok: false, reason: 'token lifetime exceeds one year' };
  if (!isHttpsUrl(b.handler_url, { noFragment: true })) return { ok: false, reason: 'handler_url must be https with no fragment' };
  if (b.icon !== undefined && !(typeof b.icon === 'string' && /^data:image\/(png|svg\+xml);base64,/.test(b.icon) && b.icon.length <= 16 * 1024 * 1.4)) {
    return { ok: false, reason: 'icon must be a small inline PNG or SVG data URI' };
  }
  return { ok: true, token: b };
}

// ─── /register (§4) ──────────────────────────────────────────────────────────

export interface RegisterParams {
  token?: WalletRegistrationToken;
  next?: string;
}

export function parseRegisterFragment(hash: string): RegisterParams {
  const p = new URLSearchParams(hash.replace(/^#/, ''));
  let token: WalletRegistrationToken | undefined;
  try {
    const raw = p.get('token');
    if (raw) token = JSON.parse(new TextDecoder().decode(base64UrlToBytes(raw))) as WalletRegistrationToken;
  } catch {
    token = undefined;
  }
  const next = p.get('next');
  return { ...(token ? { token } : {}), ...(isHttpsUrl(next) ? { next } : {}) };
}

/**
 * §4 step 2 — add-only. Updates an existing entry only with a newer token;
 * makes the wallet default only when there is no default; never changes an
 * existing default.
 */
export function registerWallet(storage: RouterStorage, token: WalletRegistrationTokenBody, now: Date): RouterStorage {
  const wallets = [...storage.wallets];
  const i = wallets.findIndex((w) => norm(w.app_card) === norm(token.app_card));
  const entry: StoredWallet = {
    app_card: token.app_card,
    name: token.name,
    ...(token.icon ? { icon: token.icon } : {}),
    handler_url: token.handler_url,
    registered_at: i >= 0 ? wallets[i]!.registered_at : now.toISOString(),
    token_issued_at: token.issued_at,
  };
  if (i >= 0) {
    if (Date.parse(token.issued_at) > Date.parse(wallets[i]!.token_issued_at)) wallets[i] = entry;
  } else {
    wallets.push(entry);
  }
  const def = storage.default ?? entry.app_card;
  return { version: 1, wallets, default: def };
}

/** §8 settings page — the only way to change the default. */
export function setDefault(storage: RouterStorage, appCard: string): RouterStorage {
  return storage.wallets.some((w) => w.app_card === appCard) ? { ...storage, default: appCard } : storage;
}

export function removeWallet(storage: RouterStorage, appCard: string): RouterStorage {
  const wallets = storage.wallets.filter((w) => w.app_card !== appCard);
  const def = storage.default === appCard ? wallets[0]?.app_card : storage.default;
  return { version: 1, wallets, ...(def ? { default: def } : {}) };
}

// ─── Recovery (§6) ───────────────────────────────────────────────────────────

/** Certified wallets for the current platform (§6 option 1). */
export function walletsForPlatform(certified: CertifiedWallet[], platform: 'web' | 'ios' | 'android'): CertifiedWallet[] {
  return certified.filter((c) => c.platforms.includes(platform) || c.platforms.includes('web'));
}

/** §6 option 3: the address-lookup URL for a typed wallet domain. */
export function addressLookupUrl(input: string): string | null {
  const host = input.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(host)) return null;
  return `https://${host}/.well-known/membership-wallet`;
}
