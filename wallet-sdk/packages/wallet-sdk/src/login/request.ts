/**
 * Wallet side of card login: receiving and validating a request, matching held
 * cards, and the wallet-initiated shortcut (wallet_sdk.md §7a.1–7a.3,
 * process_specs/card_login.md Phases 2–4 and 7).
 */
import {
  type CardVerifier,
  requestHash,
  httpsOrigin,
  signingBytes,
  mlDsa44Verify,
  readCardFields,
  matchMcardQuery,
  type AuthenticationRequest,
  type ChainContext,
  type ServerCardVerificationResult,
} from '@membership-card-protocol/verifier';
import { base64UrlToBytes, bytesToBase64Url, keccak256 } from '@membership-card-protocol/app-sdk';

export type LoginHandoff = { requestUri: string; via: 'router' | 'deeplink' | 'qr' };

const CLOCK_SKEW_MS = 60_000;
const MAX_REQUEST_LIFETIME_MS = 10 * 60_000;

/**
 * §7a.1 — accepts a handler URL with `#request_uri=…` (from the login router),
 * or an `mcard://auth?r=…` link (opened on this device, or scanned as a QR).
 */
export function parseLoginHandoff(input: { url: string; scanned?: boolean }): LoginHandoff | { error: 'LOGIN_REQUEST_MALFORMED' } {
  let requestUri: string | null = null;
  let via: LoginHandoff['via'];
  if (input.url.startsWith('mcard://')) {
    // dns_resolution.md §2: reserved action host `auth`, never parsed as a CID or domain.
    const m = /^mcard:\/\/auth\?(.*)$/.exec(input.url);
    if (!m) return { error: 'LOGIN_REQUEST_MALFORMED' };
    requestUri = new URLSearchParams(m[1]).get('r');
    via = input.scanned ? 'qr' : 'deeplink';
  } else {
    try {
      requestUri = new URLSearchParams(new URL(input.url).hash.slice(1)).get('request_uri');
    } catch {
      return { error: 'LOGIN_REQUEST_MALFORMED' };
    }
    via = 'router';
  }
  if (!requestUri || !requestUri.startsWith('https://')) return { error: 'LOGIN_REQUEST_MALFORMED' };
  return { requestUri, via };
}

export type ValidatedLoginRequest = {
  valid: true;
  request: AuthenticationRequest;
  requestHash: string;
  origin: string;
  serverCard: Extract<ServerCardVerificationResult, { valid: true }>;
  warnings: string[];
};

const reject = (code: string, reason: string) => ({ valid: false as const, code, reason });

/** Shape checks from card_login.md step 11. Returns a reason, or null if well-formed. */
function shapeProblem(r: Partial<AuthenticationRequest>): string | null {
  for (const f of ['dcql_query', 'expires_at', 'nonce', 'purpose', 'request_signature', 'requester_card', 'requester_pubkey', 'response_mode', 'response_uri', 'state', 'statement', 'version'] as const) {
    if (r[f] === undefined || r[f] === null || r[f] === '') return `missing ${f}`;
  }
  if (r.version !== '2') return `unknown version ${String(r.version)}`;
  if (r.response_mode !== 'form_post' && r.response_mode !== 'mcard_message') return `unknown response_mode ${String(r.response_mode)}`;
  if (!httpsOrigin(r.response_uri!) || new URL(r.response_uri!).port !== '') return 'response_uri must be https, default port, no fragment or userinfo';
  const creds = r.dcql_query?.credentials;
  if (!Array.isArray(creds) || creds.length !== 1) return 'dcql_query must have exactly one credential';
  if (creds[0]!.format !== 'mcard' || !Array.isArray(creds[0]!.meta?.policies) || creds[0]!.meta.policies.length === 0) return 'credential must be format mcard with at least one policy';
  return null;
}

/**
 * §7a.2 — card_login.md steps 10–16. Nothing from a request may be shown to
 * the user unless this returns `valid: true`.
 */
export async function fetchAndValidateLoginRequest(options: {
  handoff: LoginHandoff;
  verifier: CardVerifier;
  fetch: typeof globalThis.fetch;
  now?: Date;
}): Promise<ValidatedLoginRequest | { valid: false; code: string; reason: string }> {
  const now = options.now ?? new Date();
  // Step 10 — fetch with no credentials.
  let request: AuthenticationRequest;
  try {
    const res = await options.fetch(options.handoff.requestUri, { credentials: 'omit', headers: { accept: 'application/json' } });
    if (res.status !== 200) return reject('LOGIN_REQUEST_UNAVAILABLE', `request_uri returned ${res.status}`);
    request = (await res.json()) as AuthenticationRequest;
  } catch (e) {
    return reject('LOGIN_REQUEST_UNAVAILABLE', String(e));
  }
  // Step 11 — shape and expiry.
  const problem = shapeProblem(request);
  if (problem) return reject('LOGIN_REQUEST_MALFORMED', problem);
  const expires = Date.parse(request.expires_at);
  if (Number.isNaN(expires) || expires <= now.getTime() || expires > now.getTime() + MAX_REQUEST_LIFETIME_MS + CLOCK_SKEW_MS) {
    return reject('LOGIN_REQUEST_EXPIRED', 'request is expired or expires too far in the future');
  }
  // Step 12 — binding and signature.
  let pk: Uint8Array;
  try {
    pk = base64UrlToBytes(request.requester_pubkey);
  } catch {
    return reject('LOGIN_REQUEST_MALFORMED', 'requester_pubkey is not base64url');
  }
  if (keccak256(pk) !== request.requester_card.toLowerCase().replace(/^0x/, '')) {
    return reject('LOGIN_REQUESTER_BINDING_MISMATCH', 'keccak256(requester_pubkey) != requester_card');
  }
  let sigOk = false;
  try {
    sigOk = mlDsa44Verify(pk, signingBytes(request, 'request_signature'), base64UrlToBytes(request.request_signature));
  } catch {
    sigOk = false;
  }
  if (!sigOk) return reject('LOGIN_REQUEST_SIGNATURE_INVALID', 'request_signature does not verify');
  // Steps 13–16 — server card, login service card, domain binding, warnings.
  const origin = httpsOrigin(request.response_uri)!;
  const serverCard = await options.verifier.verifyServerCard(request.requester_pubkey, { origin, now: now.toISOString() });
  if (!serverCard.valid) return reject(serverCard.code, serverCard.reason);
  return { valid: true, request, requestHash: requestHash(request), origin, serverCard, warnings: [...serverCard.warnings] };
}

/** A card the wallet holds, by public key. */
export interface HeldCard {
  pubkey: string;
}

/** §7a.3 — protocol-objects.md §8.1 against every held card. */
export async function matchLoginCredentials(options: {
  request: AuthenticationRequest;
  heldCards: HeldCard[];
  chain: ChainContext;
}): Promise<{ card: string; pubkey: string; matchedPolicy: string }[]> {
  const query = options.request.dcql_query.credentials[0]!;
  const out: { card: string; pubkey: string; matchedPolicy: string }[] = [];
  for (const held of options.heldCards) {
    const card = await readCardFields(held.pubkey, options.chain);
    if (!card) continue;
    const m = await matchMcardQuery(card.fields, query, options.chain, card.address);
    if (m.matched) out.push({ card: card.address, pubkey: held.pubkey, matchedPolicy: m.policy });
  }
  return out;
}

// ─── Wallet-initiated logins (card_login.md Phase 7, step 18) ───────────────

export interface PendingWalletLogin {
  origin: string;
  walletNonce: string;
  expiresAt: string;
  card?: string;
}

export interface PendingWalletLoginStore {
  create(entry: PendingWalletLogin): Promise<void>;
  /** Atomically consumes a matching, unexpired entry. */
  consumeIfMatch(walletNonce: string, origin: string, now: Date): Promise<PendingWalletLogin | null>;
}

export function createInMemoryPendingWalletLoginStore(): PendingWalletLoginStore {
  const entries = new Map<string, PendingWalletLogin>();
  return {
    async create(entry) {
      entries.set(entry.walletNonce, entry);
    },
    async consumeIfMatch(walletNonce, origin, now) {
      const e = entries.get(walletNonce);
      if (!e) return null;
      entries.delete(walletNonce);
      if (e.origin !== origin || Date.parse(e.expiresAt) <= now.getTime()) return null;
      return e;
    },
  };
}

export const PENDING_WALLET_LOGIN_TTL_MS = 2 * 60_000;

/** Steps 29–30: records the pending login and returns the URL to open. */
export async function startWalletInitiatedLogin(options: {
  startUrl: string;
  store: PendingWalletLoginStore;
  walletAppCard: string;
  card?: string;
  now?: Date;
}): Promise<{ openUrl: string; walletNonce: string }> {
  const now = options.now ?? new Date();
  const u = new URL(options.startUrl);
  if (u.protocol !== 'https:') throw new Error('startWalletInitiatedLogin: start_url must be https');
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const walletNonce = bytesToBase64Url(bytes);
  await options.store.create({
    origin: u.origin,
    walletNonce,
    expiresAt: new Date(now.getTime() + PENDING_WALLET_LOGIN_TTL_MS).toISOString(),
    ...(options.card ? { card: options.card } : {}),
  });
  u.searchParams.set('wallet_nonce', walletNonce);
  u.searchParams.set('wallet_hint', options.walletAppCard);
  return { openUrl: u.toString(), walletNonce };
}

/**
 * Step 18: skip the prompt only when the request echoes a pending
 * wallet-initiated login for the same origin, nothing raised a warning, and
 * exactly one card applies (or the pending login named a matching card).
 */
export async function shouldSkipPrompt(options: {
  validated: ValidatedLoginRequest;
  matches: { card: string }[];
  store: PendingWalletLoginStore;
  now?: Date;
}): Promise<{ skip: true; card: string } | { skip: false }> {
  const { request, origin, warnings } = options.validated;
  if (!request.wallet_nonce || warnings.length > 0) return { skip: false };
  const pending = await options.store.consumeIfMatch(request.wallet_nonce, origin, options.now ?? new Date());
  if (!pending) return { skip: false };
  if (pending.card) {
    const m = options.matches.find((x) => x.card === pending.card);
    return m ? { skip: true, card: m.card } : { skip: false };
  }
  return options.matches.length === 1 ? { skip: true, card: options.matches[0]!.card } : { skip: false };
}
