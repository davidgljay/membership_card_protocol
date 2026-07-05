import { gcm } from '@noble/ciphers/aes.js';
import { randomBytes } from '@noble/hashes/utils.js';
import { hkdfSha3256 } from '../crypto/hashes.js';
import { mlKem768Encapsulate } from '../crypto/mlkem.js';
import { bytesToBase64Url } from '../util/base64url.js';
import type { CardMessageEnvelope } from './envelope.js';

/**
 * Sender-side per-subcard fan-out (`message_routing.md §Sender-Side
 * Fan-out`): resolve the recipient card's current sub-card list from the
 * on-chain storage contract, then encrypt the same `CardMessageEnvelope`
 * independently to each sub-card's ML-KEM public key, producing N
 * independent routing envelopes — never one ciphertext copied N times.
 *
 * Each sub-card's routing envelope carries `to` (recipient card hash) and
 * `subcard_hash` in the clear (`message_routing.md`'s routing envelope
 * shape) and an encrypted `payload` opaque to everyone but the device
 * holding that sub-card's ML-KEM private key.
 *
 * **Content encryption, not just ML-KEM.** ML-KEM alone only yields a
 * shared secret (a KEM, not an AEAD) — the envelope bytes themselves are
 * encrypted with AES-256-GCM under a key derived from that shared secret
 * via HKDF-SHA3-256, mirroring the same encapsulate-then-derive-then-AEAD
 * shape `ARCHITECTURE.md` ADR-006/ADR-007 already establishes for this
 * package's other KEM-backed encryption (`HpkeObliviousProtocolTransport`
 * uses the analogous HPKE-native `export()` construction; ML-KEM has no
 * such built-in, so this module derives the AEAD key explicitly instead).
 */

const CONTENT_KEY_INFO = 'card-protocol-message-fanout-v1';
const CONTENT_KEY_LENGTH = 32;

export interface SubCardRecipient {
  /** `keccak256(subcard_pubkey)` — the registered device this copy is for. */
  subCardHash: string;
  /** The sub-card's ML-KEM-768 public key, resolved from the on-chain storage contract. */
  mlKemPublicKey: Uint8Array;
}

export interface RoutingEnvelope {
  /** Recipient card hash — on-chain registry address. */
  to: string;
  /** Which registered sub-card this copy is encrypted for. */
  subcard_hash: string;
  /** ML-KEM-encrypted `CardMessageEnvelope`, base64url. Opaque to the routing layer. */
  payload: string;
}

/**
 * Encrypt `envelope` independently to each of `recipient`'s registered
 * sub-cards, producing one distinct `RoutingEnvelope` per sub-card. A
 * sub-card registered after this call resolves its recipient list will
 * not retroactively receive the message (`message_routing.md`) — that is
 * expected, not a bug in this function.
 */
export function fanOutMessageToSubCards(
  recipientCardHash: string,
  envelope: CardMessageEnvelope,
  subCards: SubCardRecipient[]
): RoutingEnvelope[] {
  if (subCards.length === 0) {
    throw new Error('fanOutMessageToSubCards: recipient has no registered sub-cards to deliver to.');
  }
  const plaintext = new TextEncoder().encode(JSON.stringify(envelope));

  return subCards.map((subCard) => {
    const { cipherText, sharedSecret } = mlKem768Encapsulate(subCard.mlKemPublicKey);
    const contentKey = hkdfSha3256(sharedSecret, CONTENT_KEY_INFO, CONTENT_KEY_LENGTH);
    const nonce = randomBytes(12);
    const ciphertext = gcm(contentKey, nonce).encrypt(plaintext);

    // Self-contained blob: encapsulated KEM ciphertext length-prefixed,
    // followed by the AES-GCM nonce, followed by the AEAD ciphertext — a
    // recipient with only the sub-card's ML-KEM secret key can recover
    // everything needed to decrypt with no side-channel metadata.
    const lengthPrefix = new Uint8Array(4);
    new DataView(lengthPrefix.buffer).setUint32(0, cipherText.length, false);
    const blob = new Uint8Array(lengthPrefix.length + cipherText.length + nonce.length + ciphertext.length);
    blob.set(lengthPrefix, 0);
    blob.set(cipherText, lengthPrefix.length);
    blob.set(nonce, lengthPrefix.length + cipherText.length);
    blob.set(ciphertext, lengthPrefix.length + cipherText.length + nonce.length);

    return {
      to: recipientCardHash,
      subcard_hash: subCard.subCardHash,
      payload: bytesToBase64Url(blob),
    };
  });
}
