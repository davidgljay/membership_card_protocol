/**
 * OHTTP-style oblivious gateway (notary_host.md §6; oblivious_transport.md §Notary Host Destination). The same
 * lightweight HPKE envelope as the press and wallet-service gateways (kept in sync deliberately): the gateway
 * removes only the **outer** envelope. The body it dispatches is a `SealedInput`, encrypted to the enclave's job
 * key, which the host cannot open. Copied from press/src/ohttp-gateway.ts (code-plan principle 4).
 */
import { AeadId, CipherSuite, KdfId, KemId } from "hpke-js";
import { x25519 } from "@noble/curves/ed25519";
import { gcm } from "@noble/ciphers/aes.js";

const SUITE = new CipherSuite({ kem: KemId.DhkemX25519HkdfSha256, kdf: KdfId.HkdfSha256, aead: AeadId.Aes256Gcm });
const RESPONSE_KEY_INFO = new TextEncoder().encode("card-protocol-ohttp-response-v1");

export interface HpkeKeyConfigJson { kemId: number; kdfId: number; aeadId: number; publicKey: string; targetId: string }
export interface OhttpEnvelope { path: string; method: string; headers?: Record<string, string>; body?: string }
export interface OhttpResponseEnvelope { status: number; headers?: Record<string, string>; body?: string }

export function getKeyConfig(privateKey: Uint8Array, targetId: string): HpkeKeyConfigJson {
  return { kemId: KemId.DhkemX25519HkdfSha256, kdfId: KdfId.HkdfSha256, aeadId: AeadId.Aes256Gcm, publicKey: Buffer.from(x25519.getPublicKey(privateKey)).toString("base64url"), targetId };
}

export async function decapsulate(privateKeyBytes: Uint8Array, req: { enc: string; ciphertext: string }): Promise<{
  envelope: OhttpEnvelope; encapsulateResponse: (r: OhttpResponseEnvelope) => Promise<{ nonce: string; ciphertext: string }>;
}> {
  const sk = await SUITE.kem.deserializePrivateKey(ab(privateKeyBytes));
  const recipient = await SUITE.createRecipientContext({ recipientKey: sk, enc: ab(new Uint8Array(Buffer.from(req.enc, "base64url"))) });
  const plaintext = await recipient.open(ab(new Uint8Array(Buffer.from(req.ciphertext, "base64url"))));
  const envelope = JSON.parse(new TextDecoder().decode(plaintext)) as OhttpEnvelope;
  const responseKey = new Uint8Array(await recipient.export(RESPONSE_KEY_INFO, 32));
  return {
    envelope,
    encapsulateResponse: async (response) => {
      const nonce = crypto.getRandomValues(new Uint8Array(12));
      const ct = gcm(responseKey, nonce).encrypt(new TextEncoder().encode(JSON.stringify(response)));
      return { nonce: Buffer.from(nonce).toString("base64url"), ciphertext: Buffer.from(ct).toString("base64url") };
    },
  };
}

const ab = (b: Uint8Array): ArrayBuffer => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
