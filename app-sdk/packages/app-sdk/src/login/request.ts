/**
 * Site-side login setup and request issuance (app_sdk.md §9a.1–9a.2,
 * process_specs/card_login.md Phase 0 step 3 and Phase 1).
 */
import { requestHash, httpsOrigin } from '@membership-card-protocol/verifier';
import type {
  AuthenticationRequest,
  CardPredicate,
  McardPolicyRef,
  ResponseMode,
  UnsignedAuthenticationRequest,
} from '@membership-card-protocol/verifier';
import { canonicalize } from '../crypto/canonicalize.js';
import { keccak256 } from '../crypto/hashes.js';
import { bytesToBase64Url } from '../util/base64url.js';
import type { SecureKeyProvider } from '../providers/SecureKeyProvider.js';
import type { SubCardDocumentFields } from '../subcards/types.js';
import type { LoginStore } from './store.js';

const randomB64 = (bytes: number) => bytesToBase64Url(crypto.getRandomValues(new Uint8Array(bytes)));

export const SERVER_CARD_CAPABILITIES = ['auth_request', 'auth_confirmation', 'error'];
export const MAX_REQUEST_TTL_SECONDS = 600;

/** The server card's identity, as the login functions need it. */
export interface ServerCardIdentity {
  /** keccak256(pubkey), lowercase hex. */
  pointer: string;
  /** base64url ML-DSA-44 public key. */
  pubkey: string;
  /** SecureKeyProvider key id holding the private key. */
  keyId: string;
}

/**
 * §9a.1 — generates the server key and builds the unsigned server card
 * SubCardDocument (subcards.md §Server Cards). The site operator's wallet
 * signs it as both app and holder (wallet_sdk.md §7a.6).
 */
export async function createServerCardRequest(options: {
  loginServiceCard: string;
  loginServiceCardPubkey: string;
  keyProvider: SecureKeyProvider;
  keyId: string;
  validUntil?: string;
  issuedAt?: string;
}): Promise<{ unsignedDocument: SubCardDocumentFields; server: ServerCardIdentity }> {
  const publicKey = await options.keyProvider.generateKey(options.keyId);
  const pubkey = bytesToBase64Url(publicKey);
  const unsignedDocument: SubCardDocumentFields = {
    holder_primary_card: options.loginServiceCard,
    holder_primary_card_pubkey: options.loginServiceCardPubkey,
    app_card: options.loginServiceCard,
    app_card_pubkey: options.loginServiceCardPubkey,
    capabilities: [...SERVER_CARD_CAPABILITIES],
    recipient_pubkey: pubkey,
    issued_at: options.issuedAt ?? new Date().toISOString(),
    ...(options.validUntil ? { valid_until: options.validUntil } : {}),
    attestation_level: 'S1',
  };
  return { unsignedDocument, server: { pointer: keccak256(publicKey), pubkey, keyId: options.keyId } };
}

export interface CreateLoginRequestOptions {
  server: ServerCardIdentity;
  keyProvider: SecureKeyProvider;
  store: LoginStore;
  policies: McardPolicyRef[];
  predicate?: CardPredicate;
  responseMode: ResponseMode;
  responseUri: string;
  purpose: string;
  /** Default: "Log in to <origin of responseUri>". */
  statement?: string;
  context?: Record<string, string>;
  /** From parseWalletStart, on wallet-initiated logins only. */
  walletNonce?: string;
  /** Default 300, max 600. */
  ttlSeconds?: number;
  now?: Date;
}

/**
 * §9a.2 — creates, signs, and stores an AuthenticationRequest
 * (protocol-objects.md §8). The site hosts it at a URL containing `requestId`
 * and serves it with serveLoginRequest.
 */
export async function createLoginRequest(options: CreateLoginRequestOptions): Promise<{
  request: AuthenticationRequest;
  requestId: string;
  state: string;
  requestHash: string;
}> {
  const origin = httpsOrigin(options.responseUri);
  if (!origin) throw new Error('createLoginRequest: responseUri must be an https URL with no fragment or userinfo');
  if (new URL(options.responseUri).port !== '') throw new Error('createLoginRequest: responseUri must use the default port');
  if (options.policies.length === 0) throw new Error('createLoginRequest: at least one policy is required');
  const ttl = options.ttlSeconds ?? 300;
  if (ttl <= 0 || ttl > MAX_REQUEST_TTL_SECONDS) throw new Error(`createLoginRequest: ttlSeconds must be 1–${MAX_REQUEST_TTL_SECONDS}`);
  const now = options.now ?? new Date();

  const state = randomB64(16);
  const unsigned: UnsignedAuthenticationRequest = {
    ...(options.context ? { context: options.context } : {}),
    dcql_query: {
      credentials: [
        {
          id: 'membership',
          format: 'mcard',
          meta: { policies: options.policies, ...(options.predicate ? { predicate: options.predicate } : {}) },
        },
      ],
    },
    expires_at: new Date(now.getTime() + ttl * 1000).toISOString(),
    nonce: randomB64(32),
    purpose: options.purpose,
    requester_card: options.server.pointer,
    requester_pubkey: options.server.pubkey,
    response_mode: options.responseMode,
    response_uri: options.responseUri,
    state,
    statement: options.statement ?? `Log in to ${origin}`,
    version: '2',
    ...(options.walletNonce ? { wallet_nonce: options.walletNonce } : {}),
  };
  const signature = await options.keyProvider.sign(options.server.keyId, canonicalize(unsigned));
  const request: AuthenticationRequest = { ...unsigned, request_signature: bytesToBase64Url(signature) };
  const hash = requestHash(request);
  const requestId = randomB64(16);
  await options.store.putPending({
    state,
    requestId,
    request,
    requestHash: hash,
    status: 'issued',
    createdAt: now.toISOString(),
  });
  return { request, requestId, state, requestHash: hash };
}

/**
 * Serves a hosted request (card_login.md step 5): 200 while the login is
 * still `issued` and unexpired, 410 afterwards. Callers add
 * `Cache-Control: no-store`.
 */
export async function serveLoginRequest(
  store: LoginStore,
  requestId: string,
  now: Date = new Date()
): Promise<{ status: 200; body: AuthenticationRequest } | { status: 410 }> {
  const pending = await store.getByRequestId(requestId);
  if (!pending || pending.status !== 'issued' || Date.parse(pending.request.expires_at) <= now.getTime()) {
    return { status: 410 };
  }
  return { status: 200, body: pending.request };
}
