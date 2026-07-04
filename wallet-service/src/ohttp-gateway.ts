/**
 * OHTTP-style oblivious-forwarding gateway (client-sdk implementation plan
 * Step 1.4c) — the wallet-service-side counterpart of
 * client-sdk's crypto/hpke.ts and relay's oblivious-forwarding endpoint
 * (Step 1.4b). Per CP-0, this is a lightweight custom HPKE envelope, not
 * strict RFC 9458 Binary HTTP encoding — same design as client-sdk's, kept
 * in sync deliberately (see that file's doc for why hpke-js's
 * RecipientContext can't do bidirectional seal(), and why the response key
 * is derived via HPKE export() instead).
 *
 * HPKE keypair generation/loading: the private key is stored via the
 * existing SecretsBackend/SecretsService (server/utils/secrets.ts) — the
 * same envelope-encryption machinery already built for service_secret —
 * wrapped ciphertext persisted in the KV store (server/utils/kv-store.ts)
 * under a fixed key, not a new secret-storage mechanism.
 */

import { AeadId, CipherSuite, KdfId, KemId } from 'hpke-js';
import { gcm } from '@noble/ciphers/aes.js';
import { createKvStore } from '../server/utils/kv-store.js';
import { getSecretsService } from '../server/utils/secrets.js';

const SUITE = new CipherSuite({
  kem: KemId.DhkemX25519HkdfSha256,
  kdf: KdfId.HkdfSha256,
  aead: AeadId.Aes256Gcm,
});

const RESPONSE_KEY_INFO = new TextEncoder().encode('card-protocol-ohttp-response-v1');
const RESPONSE_KEY_LENGTH = 32;
const KV_KEY = 'wallet:ohttp:keypair';

export interface HpkeKeyConfigJson {
  kemId: number;
  kdfId: number;
  aeadId: number;
  publicKey: string; // base64url
  targetId: string;
}

interface StoredKeypair {
  publicKey: string; // base64url, plaintext (public)
  ciphertext: string; // SecretsService-encrypted private key
  dekEnc: string;
}

let cachedKeyPromise: Promise<{ publicKey: Uint8Array; secretKey: Uint8Array }> | null = null;

async function getOrCreateKeypair(): Promise<{ publicKey: Uint8Array; secretKey: Uint8Array }> {
  cachedKeyPromise ??= (async () => {
    const kv = createKvStore();
    const stored = await kv.getItem<StoredKeypair>(KV_KEY);
    const secretsService = getSecretsService();

    if (stored) {
      const secretKey = await secretsService.decryptSecret(stored.ciphertext, stored.dekEnc);
      return { publicKey: base64UrlToBytes(stored.publicKey), secretKey: new Uint8Array(secretKey) };
    }

    const kp = await SUITE.kem.generateKeyPair();
    const publicKey = new Uint8Array(await SUITE.kem.serializePublicKey(kp.publicKey));
    const secretKeyBytes = new Uint8Array(await SUITE.kem.serializePrivateKey(kp.privateKey));
    const { ciphertext, dekEnc } = await secretsService.encryptSecret(Buffer.from(secretKeyBytes));

    await kv.setItem<StoredKeypair>(KV_KEY, {
      publicKey: bytesToBase64Url(publicKey),
      ciphertext,
      dekEnc,
    });

    return { publicKey, secretKey: secretKeyBytes };
  })();
  return cachedKeyPromise;
}

/** Test-only: reset the module-level keypair cache between test cases. */
export function _resetOhttpGatewayCacheForTests(): void {
  cachedKeyPromise = null;
}

export async function getKeyConfig(targetId: string): Promise<HpkeKeyConfigJson> {
  const { publicKey } = await getOrCreateKeypair();
  return {
    kemId: KemId.DhkemX25519HkdfSha256,
    kdfId: KdfId.HkdfSha256,
    aeadId: AeadId.Aes256Gcm,
    publicKey: bytesToBase64Url(publicKey),
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
export async function decapsulate(requestBodyJson: {
  enc: string;
  ciphertext: string;
}): Promise<{
  envelope: OhttpEnvelope;
  encapsulateResponse: (response: OhttpResponseEnvelope) => Promise<{ nonce: string; ciphertext: string }>;
}> {
  const { secretKey } = await getOrCreateKeypair();

  const privateKey = await SUITE.kem.deserializePrivateKey(toArrayBuffer(secretKey));
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
      return { nonce: bytesToBase64Url(nonce), ciphertext: bytesToBase64Url(ciphertext) };
    },
  };
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

function base64UrlToBytes(input: string): Uint8Array {
  return new Uint8Array(Buffer.from(input, 'base64url'));
}
