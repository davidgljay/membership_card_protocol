/**
 * Receiving login responses and binding them to the browser (app_sdk.md
 * §9a.3, process_specs/card_login.md steps 23–27).
 */
import type {
  AuthenticationRequest,
  AuthenticationResponse,
  CardVerifier,
  LoginVerificationResult,
  SignedMessageEnvelope,
} from '@membership-card-protocol/verifier';
import { base64UrlToBytes } from '../util/base64url.js';
import { buildMessagePayload, signMessageEnvelope, type CardMessageEnvelope } from '../messaging/envelope.js';
import type { SecureKeyProvider } from '../providers/SecureKeyProvider.js';
import type { LoginStore, PendingLogin } from './store.js';
import type { ServerCardIdentity } from './request.js';

export type LoginOutcome = { ok: true; presentedCard: string; verification?: LoginVerificationResult } | { ok: false; code: string; reason: string };

const fail = (code: string, reason: string) => ({ ok: false as const, code, reason });

async function loadIssued(store: LoginStore, state: string | undefined, now: Date): Promise<PendingLogin | null> {
  if (!state) return null;
  const pending = await store.getPending(state);
  if (!pending || pending.status !== 'issued' || Date.parse(pending.request.expires_at) <= now.getTime()) return null;
  return pending;
}

function originOf(request: AuthenticationRequest): string {
  return new URL(request.response_uri).origin;
}

/**
 * form_post (card_login.md steps 23–24). `body` is the parsed
 * application/x-www-form-urlencoded POST; `cookieState` is the state cookie
 * from the same request. On success the site establishes its session bound to
 * `presentedCard`, clears the cookie, and redirects (303).
 */
export async function handleFormPost(options: {
  body: { state?: string; auth_response?: string; error?: string };
  cookieState: string | undefined;
  store: LoginStore;
  verifier: CardVerifier;
  expectedOrigin: string;
  now?: Date;
}): Promise<LoginOutcome> {
  const now = options.now ?? new Date();
  const state = options.body.state;
  const pending = await loadIssued(options.store, state, now);
  if (!pending || !state) return fail('LOGIN_STATE_UNKNOWN', 'no pending login for this state');
  if (!options.cookieState || options.cookieState !== state) {
    return fail('LOGIN_SESSION_MISMATCH', 'the state cookie does not match this response');
  }
  if (options.body.error) {
    await options.store.transition(state, 'issued', 'failed');
    return fail(options.body.error === 'access_denied' ? 'access_denied' : options.body.error, 'the user declined in their wallet');
  }
  if (!options.body.auth_response) return fail('LOGIN_STATE_UNKNOWN', 'missing auth_response');

  let signed: SignedMessageEnvelope;
  try {
    signed = JSON.parse(new TextDecoder().decode(base64UrlToBytes(options.body.auth_response))) as SignedMessageEnvelope;
  } catch {
    return fail('LOGIN_WRONG_TYPE', 'auth_response is not base64url JSON');
  }
  const response: AuthenticationResponse = { state, signed_statement: signed };
  const verification = await options.verifier.verifyLoginResponse({
    response,
    request: pending.request,
    expectedOrigin: options.expectedOrigin,
    now: now.toISOString(),
  });
  if (!verification.valid) return fail(verification.code, verification.reason);
  // A bad response leaves the login `issued`; only a good one consumes it.
  if (!(await options.store.transition(state, 'issued', 'complete', { presentedCard: verification.presented_card }))) {
    return fail('LOGIN_STATE_UNKNOWN', 'this login was already used');
  }
  return { ok: true, presentedCard: verification.presented_card, verification };
}

// ─── mcard_message ──────────────────────────────────────────────────────────

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const CODE_TTL_SECONDS = 300;
export const MAX_CODE_ATTEMPTS = 5;

/** 8 Crockford base32 characters from 40 random bits (card_login.md step 24). */
export function generateLoginCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(5));
  let bits = 0n;
  for (const b of bytes) bits = (bits << 8n) | BigInt(b);
  let out = '';
  for (let i = 0; i < 8; i++) out = CROCKFORD[Number((bits >> BigInt(5 * i)) & 31n)] + out;
  return out;
}

/** Normalizes user-typed codes: uppercase, drops separators, maps I/L→1 and O→0. */
export function normalizeLoginCode(input: string): string {
  return input.toUpperCase().replace(/[\s-]/g, '').replace(/[IL]/g, '1').replace(/O/g, '0');
}

/**
 * mcard_message (card_login.md steps 23–24). Called with each `auth_response`
 * or `error` envelope that arrives for the login service card through the
 * app-sdk inbound pipeline (§9.2). On success it records latency, issues the
 * one-time code, and sends `auth_confirmation` to the presented card.
 */
export async function handleLoginMessage(options: {
  envelope: CardMessageEnvelope<'auth_response' | 'error'>;
  messageId: string;
  receivedAt?: Date;
  store: LoginStore;
  verifier: CardVerifier;
  expectedOrigin: string;
  server: ServerCardIdentity;
  loginServiceCard: string;
  keyProvider: SecureKeyProvider;
  protocolVersion: string;
  sendConfirmation: (presentedCard: string, envelope: CardMessageEnvelope<'auth_confirmation'>) => Promise<void>;
  onLatency?: (sample: { sentAt: string; receivedAt: string; latencyMs: number }) => void;
}): Promise<{ ok: true; state: string } | { ok: false; code: string; reason: string }> {
  const now = options.receivedAt ?? new Date();
  const payload = options.envelope.payload;
  const state = (payload.content as { state?: string }).state;
  const pending = await loadIssued(options.store, state, now);
  if (!pending || !state) return fail('LOGIN_STATE_UNKNOWN', 'no pending login for this state');

  if (payload.type === 'error') {
    // A decline must at least carry a valid signature from a card the
    // response could have come from; the verifier checks the signature.
    const v = await options.verifier.verifyEnvelope(options.envelope as unknown as SignedMessageEnvelope);
    if (v.signatures[0]?.signature_valid === true) await options.store.transition(state, 'issued', 'failed');
    return fail((payload.content as { code: string }).code, 'the user declined in their wallet');
  }

  const verification = await options.verifier.verifyLoginResponse({
    response: options.envelope as unknown as SignedMessageEnvelope,
    request: pending.request,
    expectedOrigin: options.expectedOrigin,
    now: now.toISOString(),
  });
  if (!verification.valid) return fail(verification.code, verification.reason);

  const code = generateLoginCode();
  const codeExpiresAt = new Date(now.getTime() + CODE_TTL_SECONDS * 1000).toISOString();
  const moved = await options.store.transition(state, 'issued', 'responded', {
    presentedCard: verification.presented_card,
    code,
    codeExpiresAt,
    codeAttempts: 0,
  });
  if (!moved) return fail('LOGIN_STATE_UNKNOWN', 'this login was already used');

  const sentAt = payload.timestamp;
  options.onLatency?.({ sentAt, receivedAt: now.toISOString(), latencyMs: now.getTime() - Date.parse(sentAt) });

  const confirmation = buildMessagePayload({
    type: 'auth_confirmation',
    content: { code, expires_at: codeExpiresAt, request_hash: pending.requestHash },
    recipients: [verification.presented_card],
    senders: [options.loginServiceCard],
    protocolVersion: options.protocolVersion,
    inReplyTo: options.messageId,
  });
  const envelope = await signMessageEnvelope(confirmation, [
    {
      publicKey: base64UrlToBytes(options.server.pubkey),
      sign: (message) => options.keyProvider.sign(options.server.keyId, message),
    },
  ]);
  await options.sendConfirmation(verification.presented_card, envelope);
  return { ok: true, state };
}

/**
 * Browser redemption (card_login.md step 26): the browser presents the
 * one-time code with its state cookie — by following the wallet's link
 * (`response_uri?code=…`) or typing it into the waiting page.
 */
export async function redeemLoginCode(options: {
  code: string;
  cookieState: string | undefined;
  store: LoginStore;
  now?: Date;
}): Promise<LoginOutcome> {
  const now = options.now ?? new Date();
  const state = options.cookieState;
  if (!state) return fail('LOGIN_SESSION_MISMATCH', 'no state cookie in this browser');
  const pending = await options.store.getPending(state);
  if (!pending || pending.status !== 'responded' || !pending.code || !pending.presentedCard) {
    return fail('LOGIN_CODE_INVALID', 'no login in this browser is waiting for a code');
  }
  if (!pending.codeExpiresAt || Date.parse(pending.codeExpiresAt) <= now.getTime()) {
    await options.store.transition(state, 'responded', 'failed');
    return fail('LOGIN_CODE_INVALID', 'the code has expired');
  }
  if (normalizeLoginCode(options.code) !== pending.code) {
    const attempts = (pending.codeAttempts ?? 0) + 1;
    if (attempts >= MAX_CODE_ATTEMPTS) await options.store.transition(state, 'responded', 'failed', { codeAttempts: attempts });
    else await options.store.update(state, { codeAttempts: attempts });
    return fail('LOGIN_CODE_INVALID', 'wrong code');
  }
  if (!(await options.store.transition(state, 'responded', 'complete'))) {
    return fail('LOGIN_CODE_INVALID', 'this code was already used');
  }
  return { ok: true, presentedCard: pending.presentedCard };
}

/** Waiting-page poll (card_login.md step 27). Never completes a login. */
export async function loginStatus(store: LoginStore, cookieState: string | undefined): Promise<'issued' | 'responded' | 'complete' | 'failed' | 'unknown'> {
  if (!cookieState) return 'unknown';
  return (await store.getPending(cookieState))?.status ?? 'unknown';
}

export { originOf as requestOrigin };
