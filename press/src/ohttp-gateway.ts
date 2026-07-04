/**
 * OHTTP-style oblivious-forwarding gateway (client-sdk implementation plan
 * Step 1.4d) — the press-side counterpart of client-sdk's crypto/hpke.ts
 * and relay's oblivious-forwarding endpoint (Step 1.4b). Same lightweight
 * custom HPKE envelope as wallet-service's src/ohttp-gateway.ts (CP-0);
 * kept in sync deliberately — see that file's doc for why hpke-js's
 * RecipientContext can't do bidirectional seal(), and why the response
 * key is derived via HPKE export() instead.
 *
 * Unlike wallet-service, the private key is not self-generated/persisted —
 * it's loaded from PRESS_OHTTP_PRIVATE_KEY (config.ts), matching every
 * other press key's environment-variable-sourced convention
 * (PRESS_MLDSA44_PRIVATE_KEY, PRESS_SECP256R1_PRIVATE_KEY). hpke-js has no
 * derivePublicKey(privateKey) API, so the public key is derived
 * independently via @noble/curves' x25519.getPublicKey — confirmed to
 * produce byte-identical output to hpke-js's own serializePublicKey for
 * the same keypair.
 */

import { AeadId, CipherSuite, KdfId, KemId } from 'hpke-js';
import { x25519 } from '@noble/curves/ed25519';
import { gcm } from '@noble/ciphers/aes.js';
import type { PressConfig } from './config.js';

const SUITE = new CipherSuite({
  kem: KemId.DhkemX25519HkdfSha256,
  kdf: KdfId.HkdfSha256,
  aead: AeadId.Aes256Gcm,
});

const RESPONSE_KEY_INFO = new TextEncoder().encode('card-protocol-ohttp-response-v1');
const RESPONSE_KEY_LENGTH = 32;

export interface HpkeKeyConfigJson {
  kemId: number;
  kdfId: number;
  aeadId: number;
  publicKey: string; // base64url
  targetId: string;
}

export function getKeyConfig(config: PressConfig, targetId: string): HpkeKeyConfigJson {
  const publicKey = x25519.getPublicKey(config.PRESS_OHTTP_PRIVATE_KEY);
  return {
    kemId: KemId.DhkemX25519HkdfSha256,
    kdfId: KdfId.HkdfSha256,
    aeadId: AeadId.Aes256Gcm,
    publicKey: Buffer.from(publicKey).toString('base64url'),
    targetId,
  };
}

export interface OhttpEnvelope {
  path: string;
  method: string;
  headers?: Record<string, string>;
  body?: string; // base64url
}

export interface OhttpResponseEnvelope {
  status: number;
  headers?: Record<string, string>;
  body?: string; // base64url
}

/**
 * Decapsulates a gateway request body (`{ enc, ciphertext }` JSON, both
 * base64url) into the sealed `OhttpEnvelope`, and returns a function that
 * seals a response back through the same HPKE context.
 */
export async function decapsulate(
  config: PressConfig,
  requestBodyJson: { enc: string; ciphertext: string }
): Promise<{
  envelope: OhttpEnvelope;
  encapsulateResponse: (response: OhttpResponseEnvelope) => Promise<{ nonce: string; ciphertext: string }>;
}> {
  const privateKey = await SUITE.kem.deserializePrivateKey(
    toArrayBuffer(config.PRESS_OHTTP_PRIVATE_KEY)
  );
  const recipient = await SUITE.createRecipientContext({
    recipientKey: privateKey,
    enc: toArrayBuffer(base64UrlToBytes(requestBodyJson.enc)),
  });
  const plaintext = await recipient.open(toArrayBuffer(base64UrlToBytes(requestBodyJson.ciphertext)));
  const envelope = JSON.parse(new TextDecoder().decode(plaintext)) as OhttpEnvelope;

  const responseKey = new Uint8Array(await recipient.export(RESPONSE_KEY_INFO, RESPONSE_KEY_LENGTH));

  return {
    envelope,
    encapsulateResponse: async (response) => {
      const nonce = crypto.getRandomValues(new Uint8Array(12));
      const plaintextResponse = new TextEncoder().encode(JSON.stringify(response));
      const ciphertext = gcm(responseKey, nonce).encrypt(plaintextResponse);
      return {
        nonce: Buffer.from(nonce).toString('base64url'),
        ciphertext: Buffer.from(ciphertext).toString('base64url'),
      };
    },
  };
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function base64UrlToBytes(input: string): Uint8Array {
  return new Uint8Array(Buffer.from(input, 'base64url'));
}
