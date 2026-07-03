import { AeadId, CipherSuite, KdfId, KemId } from 'hpke-js';
import { gcm } from '@noble/ciphers/aes.js';
import { randomBytes } from '@noble/hashes/utils.js';

/**
 * HPKE (RFC 9180) envelope primitives backing `ObliviousProtocolTransport`
 * (Step 1.4a) and the corresponding relay/wallet-service/press gateways
 * (Steps 1.4b–1.4d). Per CP-0's resolution, this is a lightweight custom
 * envelope — `{ path, method, body }` JSON, HPKE-sealed — not strict RFC
 * 9458 Binary HTTP encoding.
 *
 * Fixed suite: X25519 KEM, HKDF-SHA256, AES-256-GCM. One suite for the
 * whole protocol keeps every party (client, relay, wallet service, press)
 * interoperable without a negotiation step.
 *
 * hpke-js's `RecipientContext` does not implement RFC 9180's optional
 * bidirectional `seal()` (confirmed empirically — it throws
 * `NotSupportedError`), so response encryption is layered on top rather
 * than using the HPKE context directly both ways: both sides derive an
 * identical symmetric key via HPKE's `export()` (an RFC 9180-standard
 * operation both `SenderContext` and `RecipientContext` support), then use
 * that key for a plain AES-256-GCM seal/open of the response. This is the
 * same shape RFC 9458 itself uses for its response key, just without that
 * RFC's Binary HTTP framing.
 */

const SUITE = new CipherSuite({
  kem: KemId.DhkemX25519HkdfSha256,
  kdf: KdfId.HkdfSha256,
  aead: AeadId.Aes256Gcm,
});

const RESPONSE_KEY_INFO = new TextEncoder().encode('card-protocol-ohttp-response-v1');
const RESPONSE_KEY_LENGTH = 32;

export interface HpkeKeyConfig {
  kemId: number;
  kdfId: number;
  aeadId: number;
  /** Raw serialized public key bytes (33 bytes for X25519... actually 32). */
  publicKey: Uint8Array;
}

export interface HpkeEncapsulatedRequest {
  /** The HPKE encapsulated key (`enc`), needed by the recipient to derive the shared secret. */
  enc: Uint8Array;
  /** The sealed request envelope. */
  ciphertext: Uint8Array;
}

export interface HpkeEncapsulatedResponse {
  /** Random AES-GCM nonce for the response seal. */
  nonce: Uint8Array;
  ciphertext: Uint8Array;
}

/** Generate a fresh HPKE keypair and its public key config, for a gateway to publish at `/ohttp/key-config`. */
export async function hpkeGenerateKeyConfig(): Promise<{
  config: HpkeKeyConfig;
  secretKey: Uint8Array;
}> {
  const kp = await SUITE.kem.generateKeyPair();
  const publicKey = new Uint8Array(await SUITE.kem.serializePublicKey(kp.publicKey));
  const secretKey = new Uint8Array(await SUITE.kem.serializePrivateKey(kp.privateKey));
  return {
    config: {
      kemId: KemId.DhkemX25519HkdfSha256,
      kdfId: KdfId.HkdfSha256,
      aeadId: AeadId.Aes256Gcm,
      publicKey,
    },
    secretKey,
  };
}

/**
 * Sender (client) side: encapsulate `plaintext` to `recipientPublicKey`,
 * and return a function that later decrypts the matching response using
 * the same HPKE context.
 */
export async function hpkeSeal(
  recipientPublicKey: Uint8Array,
  plaintext: Uint8Array
): Promise<{
  request: HpkeEncapsulatedRequest;
  openResponse: (response: HpkeEncapsulatedResponse) => Promise<Uint8Array>;
}> {
  const publicKey = await SUITE.kem.deserializePublicKey(toArrayBuffer(recipientPublicKey));
  const sender = await SUITE.createSenderContext({ recipientPublicKey: publicKey });
  const ciphertext = new Uint8Array(await sender.seal(toArrayBuffer(plaintext)));
  const responseKey = new Uint8Array(await sender.export(RESPONSE_KEY_INFO, RESPONSE_KEY_LENGTH));

  return {
    request: { enc: new Uint8Array(sender.enc), ciphertext },
    openResponse: async (response) => aesGcmOpen(responseKey, response.nonce, response.ciphertext),
  };
}

/**
 * Recipient (gateway) side: decapsulate a request sealed by `hpkeSeal`
 * against this gateway's secret key, and return the decrypted plaintext
 * plus a function to seal the response back through the same context.
 */
export async function hpkeOpen(
  secretKey: Uint8Array,
  request: HpkeEncapsulatedRequest
): Promise<{
  plaintext: Uint8Array;
  sealResponse: (plaintext: Uint8Array) => Promise<HpkeEncapsulatedResponse>;
}> {
  const privateKey = await SUITE.kem.deserializePrivateKey(toArrayBuffer(secretKey));
  const recipient = await SUITE.createRecipientContext({
    recipientKey: privateKey,
    enc: toArrayBuffer(request.enc),
  });
  const plaintext = new Uint8Array(await recipient.open(toArrayBuffer(request.ciphertext)));
  const responseKey = new Uint8Array(
    await recipient.export(RESPONSE_KEY_INFO, RESPONSE_KEY_LENGTH)
  );

  return {
    plaintext,
    sealResponse: async (responsePlaintext) => {
      const nonce = randomBytes(12);
      const ciphertext = aesGcmSeal(responseKey, nonce, responsePlaintext);
      return { nonce, ciphertext };
    },
  };
}

function aesGcmSeal(key: Uint8Array, nonce: Uint8Array, plaintext: Uint8Array): Uint8Array {
  return gcm(key, nonce).encrypt(plaintext);
}

function aesGcmOpen(key: Uint8Array, nonce: Uint8Array, ciphertext: Uint8Array): Uint8Array {
  return gcm(key, nonce).decrypt(ciphertext);
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}
