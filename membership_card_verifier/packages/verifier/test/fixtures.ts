/**
 * Shared crypto fixtures for stage tests.
 * All keys are generated once and reused across tests using the same seed patterns.
 */
import { ml_dsa44 } from "@noble/post-quantum/ml-dsa.js";
import { createCipheriv, randomBytes } from "node:crypto";
import { canonicalize } from "../src/canonicalize.js";
import { keccak256, hkdfSha3256 } from "../src/crypto.js";
import type { CardDocument, SubCardDocument } from "../src/types.js";

export function generateKeypair() {
  const { secretKey, publicKey } = ml_dsa44.keygen();
  const address = keccak256(publicKey);
  return { secretKey, publicKey, address };
}

export function sign(secretKey: Uint8Array, data: unknown): string {
  const bytes = canonicalize(data);
  const sig = ml_dsa44.sign(bytes, secretKey);
  return Buffer.from(sig).toString("base64url");
}

export function encryptForCard(pubkey: Uint8Array, plaintext: Uint8Array): Uint8Array {
  const contentKey = hkdfSha3256(pubkey, "card-content-v1");
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", contentKey, nonce);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return new Uint8Array(Buffer.concat([nonce, ciphertext, tag]));
}

export function makeCardDoc(
  recipientPubkey: Uint8Array,
  issuerSk: Uint8Array,
  holderSk: Uint8Array,
  pressSk: Uint8Array,
  ancestryPubkeys: string[] = [],
  extra: Record<string, unknown> = {}
): CardDocument {
  const recipientPubkeyB64 = Buffer.from(recipientPubkey).toString("base64url");
  const { publicKey: issuerPub } = ml_dsa44.keygen(); // fake issuer for CID references
  const { publicKey: pressPub } = ml_dsa44.keygen();

  const offer: Partial<CardDocument> = {
    policy_id: "QmFakePolicyCID",
    issuer_card: keccak256(new Uint8Array(issuerPub)),
    press_card: keccak256(new Uint8Array(pressPub)),
    protocol_version: "0.1",
    issued_at: "2026-06-20T00:00:00Z",
    ancestry_pubkeys: ancestryPubkeys,
    ...extra,
  };

  const issuerSigInput = { ...offer };
  const issuerSig = sign(issuerSk, issuerSigInput);

  const holderSigInput = { ...offer, issuer_signature: issuerSig, recipient_pubkey: recipientPubkeyB64 };
  const holderSig = sign(holderSk, holderSigInput);

  const pressSigInput = { ...holderSigInput, holder_signature: holderSig };
  const pressSig = sign(pressSk, pressSigInput);

  return {
    ...pressSigInput,
    press_signature: pressSig,
    issuer_signature: issuerSig,
    holder_signature: holderSig,
  } as CardDocument;
}

export function makeSubCardDoc(
  holderPubkey: Uint8Array,
  holderSk: Uint8Array,
  appPubkey: Uint8Array,
  appSk: Uint8Array,
  recipientPubkey: Uint8Array
): SubCardDocument {
  const holderAddress = keccak256(holderPubkey);
  const appAddress = keccak256(appPubkey);

  const base = {
    holder_primary_card: holderAddress,
    holder_primary_card_pubkey: Buffer.from(holderPubkey).toString("base64url"),
    app_card: appAddress,
    app_card_pubkey: Buffer.from(appPubkey).toString("base64url"),
    capabilities: ["note"],
    recipient_pubkey: Buffer.from(recipientPubkey).toString("base64url"),
    issued_at: "2026-06-20T00:00:00Z",
    attestation_level: "T2" as const,
  };

  const appSig = sign(appSk, base);
  const holderSigInput = { ...base, app_signature: appSig };
  const holderSig = sign(holderSk, holderSigInput);

  return { ...holderSigInput, holder_signature: holderSig };
}
