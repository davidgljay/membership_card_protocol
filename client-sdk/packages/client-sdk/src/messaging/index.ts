export {
  buildMessagePayload,
  signMessageEnvelope,
  assembleCardMessageEnvelope,
  signMessageEnvelopeSync,
  messageId,
  type MessageType,
  type MessagePayload,
  type MessageContentByType,
  type TextContent,
  type ReplyContent,
  type EditContent,
  type ReactionContent,
  type ReadReceiptContent,
  type CardOfferContent,
  type CardOfferAcceptedContent,
  type CardOfferDeclinedContent,
  type CardUpdateNotificationContent,
  type AuthRequestContent,
  type AuthResponseContent,
  type EnvelopeSignatureEntry,
  /**
   * Re-exported as `MessageEnvelope` at this package's top level: the
   * verifier package's own `SignedMessageEnvelope` type (its generic
   * `{ payload: { message, timestamp, ... }, signatures }` shape for
   * `CardVerifier.verifyEnvelope`) is already re-exported unaliased from
   * `verification/index.ts`, and this module's concrete,
   * `messaging_protocol.md`-shaped type of the same name would otherwise
   * collide at the package barrel. Both names are used internally within
   * `messaging/` without the alias; only the top-level re-export needs it.
   */
  type CardMessageEnvelope as MessageEnvelope,
  type EnvelopeSigner,
  type BuildMessagePayloadOptions,
} from './envelope.js';
export {
  fanOutMessageToSubCards,
  type SubCardRecipient,
  type RoutingEnvelope,
} from './fanout.js';
export { decryptRoutingEnvelope } from './decrypt.js';
