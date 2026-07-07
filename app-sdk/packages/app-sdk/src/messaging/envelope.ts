import { canonicalize } from '../crypto/canonicalize.js';
import { mlDsa44Sign } from '../crypto/mldsa.js';
import { keccak256 } from '../crypto/hashes.js';
import { bytesToBase64Url } from '../util/base64url.js';

/**
 * `SignedMessageEnvelope` construction (`messaging_protocol.md`) — the
 * common envelope every message type shares, plus per-type `content`
 * shapes for this SDK's in-scope message-type taxonomy (Step 5.1's
 * "covering the message type taxonomy needed for this SDK's in-scope
 * flows at minimum"): `text`, `reply`, `edit`, `reaction`, `read_receipt`,
 * `card_offer`/`card_offer_accepted`/`card_offer_declined` (reusing
 * Phase 3's offer objects), `card_update_notification`, `auth_request`/
 * `auth_response`.
 *
 * The message ID is the hash of the canonical payload
 * (`messaging_protocol.md` — "there is no separate `id` field"); this
 * module exposes {@link messageId} so callers (dedup on receipt, edit-chain
 * linking) never need to reimplement that derivation.
 *
 * `type` lives inside `payload` and is therefore covered by every
 * signature in `signatures` — a recipient cannot be misled about what kind
 * of message they received without invalidating the signature.
 */

export type MessageType =
  | 'text'
  | 'reply'
  | 'edit'
  | 'reaction'
  | 'read_receipt'
  | 'card_offer'
  | 'card_offer_accepted'
  | 'card_offer_declined'
  | 'card_update_notification'
  | 'auth_request'
  | 'auth_response';

export interface TextContent {
  body: string;
  format?: 'plain' | 'markdown';
  attachments?: { cid: string; mime_type: string; name: string }[];
}

export interface ReplyContent {
  body: string;
  format?: 'plain' | 'markdown';
  quote?: string;
}

export interface EditContent {
  body: string;
  format?: 'plain' | 'markdown';
  edit_summary?: string;
}

export interface ReactionContent {
  emoji: string;
  target: string;
  retract?: boolean;
}

export interface ReadReceiptContent {
  target: string;
  delivered: string;
  read: string;
}

export interface CardOfferContent {
  offer_cid?: string;
  policy_pointer: string;
  issuer_signature: string;
  expires: string;
}

export interface CardOfferAcceptedContent {
  card_cid: string;
  offer_cid: string;
  holder_signature: string;
  recipient_pubkey: string;
}

export interface CardOfferDeclinedContent {
  offer_cid: string;
  reason?: string;
}

export interface CardUpdateNotificationContent {
  card_pointer: string;
  update_code: number;
  log_entry_cid: string;
  effective_date?: string;
  updater_message?: string;
}

export interface AuthRequestContent {
  requester_card: string;
  policy_cid: string;
  nonce: string;
  purpose: string;
  session_id: string;
  callback: string;
  expires: string;
}

export interface AuthResponseContent {
  statement: string;
  context: { session_id: string; [key: string]: unknown };
  nonce: string;
}

/** Maps each supported `type` to its `content` shape, for call-site type inference. */
export interface MessageContentByType {
  text: TextContent;
  reply: ReplyContent;
  edit: EditContent;
  reaction: ReactionContent;
  read_receipt: ReadReceiptContent;
  card_offer: CardOfferContent;
  card_offer_accepted: CardOfferAcceptedContent;
  card_offer_declined: CardOfferDeclinedContent;
  card_update_notification: CardUpdateNotificationContent;
  auth_request: AuthRequestContent;
  auth_response: AuthResponseContent;
}

export interface MessagePayload<T extends MessageType = MessageType> {
  type: T;
  content: MessageContentByType[T];
  recipients: string[];
  senders: string[];
  protocol_version: string;
  timestamp: string;
  edit_of?: string;
  retracts?: string;
  forwards?: string;
  in_reply_to?: string;
}

export interface EnvelopeSignatureEntry {
  public_key: string;
  signature: string;
}

/**
 * Named `CardMessageEnvelope`, not `SignedMessageEnvelope`, to avoid
 * colliding with `@membership-card-protocol/verifier`'s own
 * `SignedMessageEnvelope` type (re-exported from `verification/index.ts`)
 * — that type's `payload` shape is the verifier's generic
 * `{ message: string; timestamp: string; [key: string]: unknown }`, used
 * by `verifyEnvelope()` for arbitrary signed documents, not specifically
 * this messaging protocol's typed `MessagePayload`. Step 5.2's inbound
 * verification adapts a `CardMessageEnvelope` into the verifier's expected
 * shape before calling `verifyEnvelope()`, rather than these two types
 * being the same structural shape.
 */
export interface CardMessageEnvelope<T extends MessageType = MessageType> {
  payload: MessagePayload<T>;
  signatures: EnvelopeSignatureEntry[];
}

export interface BuildMessagePayloadOptions<T extends MessageType> {
  type: T;
  content: MessageContentByType[T];
  recipients: string[];
  senders: string[];
  protocolVersion: string;
  /** Defaults to now. */
  timestamp?: string;
  editOf?: string;
  retracts?: string;
  forwards?: string;
  inReplyTo?: string;
}

/**
 * A single signing identity for {@link signMessageEnvelope} — deliberately
 * the same `{ sign }`-callback shape as `UpdateIntentSigner`
 * (`subcards/revocation.ts`) and `WalletAppCardIdentity`
 * (`wallet/deviceSubCard.ts`), so a device sub-card key (routine signing,
 * never the master key — `auth_response` in particular "signed by the
 * holder's current device sub-card, not the master key") can be adapted to
 * this with the same one-line closure pattern already established
 * elsewhere in this SDK.
 */
export interface EnvelopeSigner {
  publicKey: Uint8Array;
  sign: (message: Uint8Array) => Uint8Array | Promise<Uint8Array>;
}

/**
 * `edit_of`, `retracts`, and `forwards` are mutually exclusive
 * (`messaging_protocol.md`'s "Common Envelope" note) — enforced at
 * construction time as defense-in-depth, since nothing in
 * {@link MessagePayload}'s structural type prevents a caller from setting
 * more than one of the three fields via object spread.
 */
export function buildMessagePayload<T extends MessageType>(
  options: BuildMessagePayloadOptions<T>
): MessagePayload<T> {
  const exclusiveFieldsSet = [options.editOf, options.retracts, options.forwards].filter(
    (v) => v !== undefined
  ).length;
  if (exclusiveFieldsSet > 1) {
    throw new Error(
      'buildMessagePayload: edit_of, retracts, and forwards are mutually exclusive; at most one may be set.'
    );
  }
  if (options.type === 'edit' && options.editOf === undefined) {
    throw new Error('buildMessagePayload: edit_of is required for type "edit".');
  }
  if (options.type === 'edit' && options.retracts !== undefined) {
    throw new Error('buildMessagePayload: type "edit" with retracts set is invalid — use retracts alone to withdraw without replacement.');
  }
  if (options.type === 'reply' && options.inReplyTo === undefined) {
    throw new Error('buildMessagePayload: in_reply_to is required for type "reply".');
  }

  return {
    type: options.type,
    content: options.content,
    recipients: options.recipients,
    senders: options.senders,
    protocol_version: options.protocolVersion,
    timestamp: options.timestamp ?? new Date().toISOString(),
    ...(options.editOf !== undefined ? { edit_of: options.editOf } : {}),
    ...(options.retracts !== undefined ? { retracts: options.retracts } : {}),
    ...(options.forwards !== undefined ? { forwards: options.forwards } : {}),
    ...(options.inReplyTo !== undefined ? { in_reply_to: options.inReplyTo } : {}),
  };
}

/**
 * Sign an already-constructed payload with one or more signers, producing
 * the complete `SignedMessageEnvelope`. Most message types have exactly one
 * signer; co-signed messages (`messaging_protocol.md`'s "co-signed messages
 * may have several") pass more than one.
 */
export async function signMessageEnvelope<T extends MessageType>(
  payload: MessagePayload<T>,
  signers: EnvelopeSigner[]
): Promise<CardMessageEnvelope<T>> {
  if (signers.length === 0) {
    throw new Error('signMessageEnvelope: at least one signer is required.');
  }
  const canonicalPayload = canonicalize(payload);
  const signatures: EnvelopeSignatureEntry[] = [];
  for (const signer of signers) {
    const signature = await signer.sign(canonicalPayload);
    signatures.push({
      public_key: bytesToBase64Url(signer.publicKey),
      signature: bytesToBase64Url(signature),
    });
  }
  return { payload, signatures };
}

/** Convenience one-shot: build the payload and sign it with a single signer. */
export async function assembleCardMessageEnvelope<T extends MessageType>(
  options: BuildMessagePayloadOptions<T>,
  signer: EnvelopeSigner
): Promise<CardMessageEnvelope<T>> {
  const payload = buildMessagePayload(options);
  return signMessageEnvelope(payload, [signer]);
}

/**
 * Sign directly with a raw secret key (test/self-contained-caller
 * convenience) rather than an {@link EnvelopeSigner} callback.
 */
export function signMessageEnvelopeSync<T extends MessageType>(
  payload: MessagePayload<T>,
  keypairs: { publicKey: Uint8Array; secretKey: Uint8Array }[]
): CardMessageEnvelope<T> {
  const canonicalPayload = canonicalize(payload);
  const signatures: EnvelopeSignatureEntry[] = keypairs.map((kp) => ({
    public_key: bytesToBase64Url(kp.publicKey),
    signature: bytesToBase64Url(mlDsa44Sign(kp.secretKey, canonicalPayload)),
  }));
  return { payload, signatures };
}

/**
 * The message ID: `keccak256(canonicalize(payload))`
 * (`messaging_protocol.md` — "The hash of the canonical payload is the
 * message ID; there is no separate `id` field"). Used for dedup on
 * receipt (Step 5.2) and edit-chain root derivation.
 */
export function messageId(payload: MessagePayload): string {
  return keccak256(canonicalize(payload));
}
