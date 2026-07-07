import type { CardVerifier, EnvelopeVerificationResult } from '../verification/index.js';
import type { StorageProvider } from '../providers/StorageProvider.js';
import { decryptRoutingEnvelope } from './decrypt.js';
import { messageId } from './envelope.js';
import type { CardMessageEnvelope, MessagePayload, MessageType } from './envelope.js';
import type { RoutingEnvelope } from './fanout.js';

/**
 * Inbound message verification and decryption (Step 5.2): decrypt a
 * `RoutingEnvelope` via ML-KEM (`decryptRoutingEnvelope`, Step 5.1), then
 * verify the inner `CardMessageEnvelope`'s signature(s) via the shared
 * `CardVerifier`'s `verifyEnvelope()` (`card_verifier.md §6.1`) — never a
 * hand-rolled signature check, matching this SDK's established pattern
 * (§6, `subcards/handleSubCardRequest.ts`).
 *
 * **Adapting to the verifier's generic envelope shape.** `verifyEnvelope`
 * expects `{ payload: { message, protocol_version, timestamp, [key]:
 * unknown }, signatures }` — a generic signed-document shape used for
 * every kind of envelope this protocol verifies, not specific to this
 * messaging module's typed `MessagePayload`. `verifyStage1` (the verifier
 * package's own signature stage) canonicalizes and verifies over
 * `payload` as received, without reading or requiring a `message` field
 * itself — so passing this module's `MessagePayload` object directly
 * (which already carries `protocol_version` and `timestamp`, satisfying
 * the verifier's structural requirement via its `[key: string]: unknown`
 * index signature) round-trips correctly. No `message` field is added or
 * needed; TypeScript's structural typing plus a targeted cast bridges the
 * two packages' otherwise-unrelated `SignedMessageEnvelope` interfaces
 * without silently duplicating verification logic locally.
 */

export type InboundRejectionCode = 'decryption_failed' | 'signature_invalid' | 'no_valid_signature';

export interface InboundRejection {
  accepted: false;
  code: InboundRejectionCode;
  reason: string;
}

export interface InboundMessage {
  accepted: true;
  envelope: CardMessageEnvelope;
  messageId: string;
  verification: EnvelopeVerificationResult;
  /** `true` if this exact message ID was already stored — a relay-retransmission duplicate, not a new message. */
  duplicate: boolean;
}

export type InboundResult = InboundMessage | InboundRejection;

export interface HandleInboundRoutingEnvelopeOptions {
  routingEnvelope: RoutingEnvelope;
  /** This device's sub-card ML-KEM-768 secret key — the one `routingEnvelope.subcard_hash` names. */
  mlKemSecretKey: Uint8Array;
  cardVerifier: CardVerifier;
  /**
   * Used for message-history deduplication (`message_routing.md §UUID
   * Re-registration and Retransmission` — "devices must deduplicate by
   * message ID"). Keyed under `messageHistoryKeyPrefix` (default
   * `'message-history:'`) plus the message ID.
   */
  storage: StorageProvider;
  messageHistoryKeyPrefix?: string;
}

const DEFAULT_HISTORY_PREFIX = 'message-history:';

/**
 * Decrypt and verify one inbound routing envelope end to end. Rejects (via
 * a typed result, never a throw) if decryption fails or no signature in
 * the recovered envelope validates — an envelope with an invalid signature
 * must never be displayed to the user. On acceptance, persists the
 * message under its message-ID key via `StorageProvider` and reports
 * whether this exact ID had already been seen (a relay-retransmission
 * duplicate must be stored once, not twice — this function performs the
 * existence check and write atomically enough for that guarantee: it
 * checks-then-sets within one call, and a caller invoking this function
 * serially, not concurrently, per device is assumed, matching how a
 * single-threaded JS event loop already serializes calls from one
 * `RealtimeTransportProvider` delivery stream).
 */
export async function handleInboundRoutingEnvelope(
  options: HandleInboundRoutingEnvelopeOptions
): Promise<InboundResult> {
  const { routingEnvelope, mlKemSecretKey, cardVerifier, storage } = options;
  const historyPrefix = options.messageHistoryKeyPrefix ?? DEFAULT_HISTORY_PREFIX;

  let envelope: CardMessageEnvelope;
  try {
    envelope = decryptRoutingEnvelope(routingEnvelope, mlKemSecretKey);
  } catch (err) {
    return {
      accepted: false,
      code: 'decryption_failed',
      reason: `failed to decrypt routing envelope: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  let verification: EnvelopeVerificationResult;
  try {
    verification = await cardVerifier.verifyEnvelope(
      envelope as unknown as Parameters<CardVerifier['verifyEnvelope']>[0]
    );
  } catch (err) {
    return {
      accepted: false,
      code: 'signature_invalid',
      reason: `verifyEnvelope threw: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const anySignatureValid = verification.signatures.some((sig) => sig.signature_valid === true);
  if (!anySignatureValid) {
    return {
      accepted: false,
      code: 'no_valid_signature',
      reason: 'no signature in the recovered envelope verified successfully — envelope must not be displayed.',
    };
  }

  const id = messageId(envelope.payload);
  const historyKey = `${historyPrefix}${id}`;
  const existing = await storage.get(historyKey);
  const duplicate = existing !== undefined;
  if (!duplicate) {
    await storage.set(historyKey, new TextEncoder().encode(JSON.stringify(envelope)));
  }

  return { accepted: true, envelope, messageId: id, verification, duplicate };
}

/**
 * Message-type-specific handling helpers. Each returns the piece of
 * derived state the caller (a message-history/UI layer this SDK does not
 * own) needs to apply the spec's linking rules — none of these mutate
 * storage themselves; `handleInboundRoutingEnvelope` above owns the one
 * durable write (dedup) this module is responsible for.
 */

/** For `type: 'edit'` — the hash this edit replaces (its immediate predecessor, per `edit_of`). */
export function editTarget(payload: MessagePayload<'edit'>): string {
  if (payload.edit_of === undefined) {
    throw new Error('editTarget: payload.edit_of is required for type "edit".');
  }
  return payload.edit_of;
}

/** For any type carrying `retracts` — the hash of the payload being withdrawn. */
export function retractionTarget(payload: MessagePayload): string | undefined {
  return payload.retracts;
}

/** For `type: 'reaction'` — the hash of the message being reacted to. */
export function reactionTarget(payload: MessagePayload<'reaction'>): string {
  return payload.content.target;
}

/**
 * Follows `edit_of` pointers to derive the root (original, `edit_of`-less)
 * message hash for a conversation thread (`messaging_protocol.md §4 edit`
 * — "the root hash is stable across all edits and serves as the canonical
 * conversation-thread anchor"). `resolvePrior` looks up a prior payload by
 * its message ID from wherever the caller's edit-chain store lives (this
 * SDK does not own that store — only the traversal algorithm).
 */
export async function resolveEditRoot(
  payload: MessagePayload,
  resolvePrior: (hash: string) => Promise<MessagePayload | undefined>
): Promise<string> {
  let current = payload;
  let currentId = messageId(current);
  while (current.edit_of !== undefined) {
    const prior = await resolvePrior(current.edit_of);
    if (prior === undefined) {
      // Prior not available locally — the immediate edit_of hash is the
      // best available anchor; a fuller history sync could resolve further.
      return current.edit_of;
    }
    current = prior;
    currentId = messageId(current);
  }
  return currentId;
}

export type { MessageType };
