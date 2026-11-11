/**
 * Building and delivering the login response, declines, and the
 * auth_confirmation hand-off (wallet_sdk.md §7a.4–7a.5, card_login.md
 * Phase 5 and steps 21–25).
 */
import {
  buildMessagePayload,
  signMessageEnvelope,
  messageId,
  fanOutMessageToSubCards,
  bytesToBase64Url,
  base64UrlToBytes,
  mlDsa44Verify,
  canonicalize,
  keccak256,
  type MessageEnvelope as CardMessageEnvelope,
  type EnvelopeSigner,
  type RoutingEnvelope,
  type SubCardRecipient,
} from '@membership-card-protocol/app-sdk';
import type { AuthenticationRequest, AuthenticationResponse, SignedMessageEnvelope } from '@membership-card-protocol/verifier';
import type { LoginHandoff, ValidatedLoginRequest } from './request.js';

/** §7a.4 — the auth_response envelope (protocol-objects.md §9). */
export async function buildLoginResponse(options: {
  validated: ValidatedLoginRequest;
  presentedCard: string;
  /** The presented card's device sub-card (capabilities include auth_response). */
  signer: EnvelopeSigner;
  protocolVersion: string;
  now?: Date;
}): Promise<{ response: AuthenticationResponse; envelope: CardMessageEnvelope<'auth_response'>; messageId: string }> {
  const { request, requestHash, origin, serverCard } = options.validated;
  const payload = buildMessagePayload({
    type: 'auth_response',
    content: { audience: origin, nonce: request.nonce, request_hash: requestHash, state: request.state, statement: request.statement },
    recipients: [serverCard.login_service_card],
    senders: [options.presentedCard],
    protocolVersion: options.protocolVersion,
    timestamp: (options.now ?? new Date()).toISOString(),
  });
  const envelope = await signMessageEnvelope(payload, [options.signer]);
  return {
    envelope,
    messageId: messageId(payload),
    response: { state: request.state, signed_statement: envelope as unknown as SignedMessageEnvelope },
  };
}

/** form_post fields for a browser wallet to submit (card_login.md step 21). */
export function formPostFields(request: AuthenticationRequest, response: AuthenticationResponse): { action: string; fields: Record<string, string> } {
  return {
    action: request.response_uri,
    fields: {
      state: response.state,
      auth_response: bytesToBase64Url(new TextEncoder().encode(JSON.stringify(response.signed_statement))),
    },
  };
}

/**
 * Native wallets on the same device open their own HTTPS form-relay page in
 * the system browser with the fields in the fragment; the page submits them.
 */
export function formRelayUrl(relayPageUrl: string, post: { action: string; fields: Record<string, string> }): string {
  const params = new URLSearchParams({ action: post.action, ...post.fields });
  return `${relayPageUrl.replace(/#.*$/, '')}#${params.toString()}`;
}

/** Decline (card_login.md step 22). */
export async function buildDecline(options: {
  validated: ValidatedLoginRequest;
  presentedCard?: string;
  signer?: EnvelopeSigner;
  protocolVersion?: string;
}): Promise<{ mode: 'form_post'; action: string; fields: Record<string, string> } | { mode: 'mcard_message'; envelope: CardMessageEnvelope<'error'> }> {
  const { request, serverCard } = options.validated;
  if (request.response_mode === 'form_post') {
    return { mode: 'form_post', action: request.response_uri, fields: { state: request.state, error: 'access_denied' } };
  }
  if (!options.signer || !options.presentedCard || !options.protocolVersion) {
    throw new Error('buildDecline: mcard_message declines need signer, presentedCard, and protocolVersion');
  }
  const payload = buildMessagePayload({
    type: 'error',
    content: { code: 'access_denied', state: request.state },
    recipients: [serverCard.login_service_card],
    senders: [options.presentedCard],
    protocolVersion: options.protocolVersion,
  });
  return { mode: 'mcard_message', envelope: await signMessageEnvelope(payload, [options.signer]) };
}

/**
 * mcard_message delivery (card_login.md step 21): fans the envelope out to the
 * login service card's active sub-cards. `resolveRecipients` supplies each
 * sub-card's ML-KEM key — the same resolution any card message needs
 * (message_routing.md §Sender-Side Fan-out).
 */
export async function sendLoginMessage(options: {
  envelope: CardMessageEnvelope;
  loginServiceCard: string;
  resolveRecipients: (card: string) => Promise<SubCardRecipient[]>;
  send: (envelopes: RoutingEnvelope[]) => Promise<void>;
}): Promise<void> {
  const recipients = await options.resolveRecipients(options.loginServiceCard);
  await options.send(fanOutMessageToSubCards(options.loginServiceCard, options.envelope, recipients));
}

/**
 * §7a.5 — card_login.md step 25: accept the confirmation only from the
 * request's server card, in reply to our response, for the same request;
 * then open the redemption link (same device) or show the code (QR).
 */
export function handleAuthConfirmation(options: {
  envelope: CardMessageEnvelope<'auth_confirmation'>;
  sentResponseId: string;
  validated: ValidatedLoginRequest;
  via: LoginHandoff['via'];
  now?: Date;
}):
  | { ok: true; action: 'open'; url: string }
  | { ok: true; action: 'show'; code: string; origin: string; expiresAt: string }
  | { ok: false; code: 'LOGIN_CONFIRMATION_INVALID'; reason: string } {
  const bad = (reason: string) => ({ ok: false as const, code: 'LOGIN_CONFIRMATION_INVALID' as const, reason });
  const { request, requestHash, origin } = options.validated;
  const p = options.envelope.payload;
  if (p.type !== 'auth_confirmation') return bad('not an auth_confirmation');
  if (p.in_reply_to !== options.sentResponseId) return bad('not a reply to our response');
  if (p.content.request_hash !== requestHash) return bad('request_hash does not match');
  const sig = options.envelope.signatures[0];
  if (!sig || options.envelope.signatures.length !== 1) return bad('expected one signature');
  const signerPk = base64UrlToBytes(sig.public_key);
  if (keccak256(signerPk) !== request.requester_card.toLowerCase().replace(/^0x/, '')) return bad('not signed by the request’s server card');
  if (!mlDsa44Verify(signerPk, canonicalize(p), base64UrlToBytes(sig.signature))) return bad('signature does not verify');
  if (!/^[0-9A-HJKMNP-TV-Z]{8}$/.test(p.content.code)) return bad('malformed code');
  if (Date.parse(p.content.expires_at) <= (options.now ?? new Date()).getTime()) return bad('code already expired');

  if (options.via === 'qr') {
    return { ok: true, action: 'show', code: p.content.code, origin, expiresAt: p.content.expires_at };
  }
  const url = new URL(request.response_uri);
  url.searchParams.set('code', p.content.code);
  return { ok: true, action: 'open', url: url.toString() };
}

/** The user-facing text for a QR-started login's code (card_login.md step 25). */
export function confirmationCodeText(code: string, origin: string): string {
  return `Enter this code at ${new URL(origin).host} — only in a browser you are using yourself: ${code}`;
}
