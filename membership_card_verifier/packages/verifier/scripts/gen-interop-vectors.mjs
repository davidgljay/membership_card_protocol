// Generates cross-language interop test vectors from the real, built JS package output.
// Run with: node scripts/gen-interop-vectors.mjs
// Writes vectors/*.json into ../verifier-py/vectors/

import { writeFileSync } from "node:fs";
import { randomBytes, createCipheriv } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { canonicalize } from "../dist/canonicalize.js";
import { keccak256, hkdfSha3256 } from "../dist/crypto.js";
import { ml_dsa44 } from "@noble/post-quantum/ml-dsa.js";
import { p256 } from "@noble/curves/p256";
import { sha256 } from "@noble/hashes/sha256";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, "../../verifier-py/vectors");

function b64url(bytes) {
  return Buffer.from(bytes).toString("base64url");
}
function hex(bytes) {
  return Buffer.from(bytes).toString("hex");
}

// ---------------------------------------------------------------------------
// 1. canonicalize — additional tricky vectors beyond specs/serialization-conformance.json
// ---------------------------------------------------------------------------
const canonicalizeCases = [
  { id: "IC-01", description: "deeply nested arrays of objects", input: { a: [{ b: [1, 2, { c: 3 }] }, { d: null }] } },
  { id: "IC-02", description: "unicode surrogate pair (emoji)", input: { emoji: "hello 😀 world" } },
  { id: "IC-03", description: "empty string key and empty string value", input: { "": "" } },
  { id: "IC-04", description: "mixed array of types", input: { arr: [1, "two", true, null, { five: 5 }, [6, 7]] } },
  { id: "IC-05", description: "keys requiring escape: quotes and backslashes", input: { 'a"b': "c\\d" } },
  { id: "IC-06", description: "large safe integer", input: { n: 9007199254740991 } },
  { id: "IC-07", description: "zero and negative zero as object values", input: { z: 0, nz: -0 } },
  { id: "IC-08", description: "array of empty objects and arrays", input: { x: [{}, [], {}] } },
  { id: "IC-09", description: "non-ASCII keys sorted by code point", input: { "é": 1, "a": 2, "中": 3 } },
  { id: "IC-10", description: "control character in string requiring escape", input: { s: "line1\nline2\ttab" } },
];

const canonicalizeVectors = canonicalizeCases.map((tc) => {
  const result = canonicalize(tc.input);
  return { ...tc, expected_json: new TextDecoder().decode(result), expected_hex: hex(result) };
});

writeFileSync(
  join(OUT_DIR, "canonicalize_vectors.json"),
  JSON.stringify({ cases: canonicalizeVectors }, null, 2)
);

// ---------------------------------------------------------------------------
// 2. keccak256 — known-input/output pairs from the real JS implementation
// ---------------------------------------------------------------------------
const keccakInputs = [
  { id: "KC-01", input_hex: "" },
  { id: "KC-02", input_hex: hex(Buffer.from("hello, card protocol", "utf-8")) },
  { id: "KC-03", input_hex: hex(new Uint8Array(1312).fill(0x42)) }, // mldsa44 pubkey-sized
  { id: "KC-04", input_hex: hex(new Uint8Array(64).fill(0x7)) },    // secp256r1 pubkey-sized
];
const keccakVectors = keccakInputs.map((tc) => ({
  ...tc,
  expected_hex: keccak256(Buffer.from(tc.input_hex, "hex")),
}));
writeFileSync(join(OUT_DIR, "keccak256_vectors.json"), JSON.stringify({ cases: keccakVectors }, null, 2));

// ---------------------------------------------------------------------------
// 3. HKDF-SHA3-256 — fixed ikm/info -> output
// ---------------------------------------------------------------------------
const hkdfInputs = [
  { id: "HK-01", ikm_hex: hex(new Uint8Array(32).fill(0x42)), info: "card-content-v1" },
  { id: "HK-02", ikm_hex: hex(new Uint8Array(32).fill(0x00)), info: "card-content-v1" },
  { id: "HK-03", ikm_hex: hex(randomBytes(32)), info: "different-info-string" },
];
const hkdfVectors = hkdfInputs.map((tc) => ({
  ...tc,
  expected_hex: hex(hkdfSha3256(Buffer.from(tc.ikm_hex, "hex"), tc.info)),
}));
writeFileSync(join(OUT_DIR, "hkdf_vectors.json"), JSON.stringify({ cases: hkdfVectors }, null, 2));

// ---------------------------------------------------------------------------
// 4. AES-256-GCM — JS-encrypted blob for Python to decrypt (ground truth: Node crypto)
// ---------------------------------------------------------------------------
function encrypt(key, nonce, plaintext) {
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([nonce, ciphertext, tag]);
}
const aesCases = [
  { id: "AES-01", key: randomBytes(32), nonce: randomBytes(12), plaintext: Buffer.from("hello, card protocol", "utf-8") },
  { id: "AES-02", key: randomBytes(32), nonce: randomBytes(12), plaintext: Buffer.from(JSON.stringify({ policy_id: "QmFakePolicyCID", issued_at: "2026-06-20T00:00:00Z" }), "utf-8") },
  { id: "AES-03", key: randomBytes(32), nonce: randomBytes(12), plaintext: Buffer.alloc(0) }, // empty plaintext
];
const aesVectors = aesCases.map((tc) => ({
  id: tc.id,
  key_hex: hex(tc.key),
  encrypted_hex: hex(encrypt(tc.key, tc.nonce, tc.plaintext)),
  expected_plaintext_hex: hex(tc.plaintext),
}));
writeFileSync(join(OUT_DIR, "aes_gcm_vectors.json"), JSON.stringify({ cases: aesVectors }, null, 2));

// ---------------------------------------------------------------------------
// 5. ML-DSA-44 — real noble-post-quantum-generated keypair/signature, verified cross-language
// ---------------------------------------------------------------------------
const mldsaMsg1 = new TextEncoder().encode("card protocol interop test message");
const mldsaKp1 = ml_dsa44.keygen();
const mldsaSig1 = ml_dsa44.sign(mldsaMsg1, mldsaKp1.secretKey);

const mldsaMsg2 = new TextEncoder().encode("a different message for the tampered case");
const mldsaKp2 = ml_dsa44.keygen();
const mldsaSig2Valid = ml_dsa44.sign(mldsaMsg2, mldsaKp2.secretKey);
const mldsaSig2Tampered = new Uint8Array(mldsaSig2Valid);
mldsaSig2Tampered[1200] ^= 0xff;

const mldsaVectors = [
  {
    id: "MLDSA-01",
    description: "valid signature, JS-generated keypair and signature",
    public_key_hex: hex(mldsaKp1.publicKey),
    message_hex: hex(mldsaMsg1),
    signature_hex: hex(mldsaSig1),
    expected_valid: true,
  },
  {
    id: "MLDSA-02",
    description: "tampered signature byte, must fail verification",
    public_key_hex: hex(mldsaKp2.publicKey),
    message_hex: hex(mldsaMsg2),
    signature_hex: hex(mldsaSig2Tampered),
    expected_valid: false,
  },
];
writeFileSync(join(OUT_DIR, "mldsa44_vectors.json"), JSON.stringify({ cases: mldsaVectors }, null, 2));

// ---------------------------------------------------------------------------
// 6. secp256r1 (P-256) SHA-256 prehash — real noble/curves-generated keypair/signature
// ---------------------------------------------------------------------------
function p256SignCompact(privKey, message) {
  const msgHash = sha256(message);
  const sig = p256.sign(msgHash, privKey);
  return sig.toCompactRawBytes();
}

const p256Msg1 = new TextEncoder().encode("card protocol secp256r1 interop test");
const p256Priv1 = p256.utils.randomPrivateKey();
const p256Pub1Full = p256.getPublicKey(p256Priv1, false); // uncompressed, 65 bytes with 0x04 prefix
const p256Pub1 = p256Pub1Full.slice(1); // strip 0x04 -> 64 bytes x||y
const p256Sig1 = p256SignCompact(p256Priv1, p256Msg1);

const p256Msg2 = new TextEncoder().encode("tampered case message");
const p256Priv2 = p256.utils.randomPrivateKey();
const p256Pub2Full = p256.getPublicKey(p256Priv2, false);
const p256Pub2 = p256Pub2Full.slice(1);
const p256Sig2Valid = p256SignCompact(p256Priv2, p256Msg2);
const p256Sig2Tampered = new Uint8Array(p256Sig2Valid);
p256Sig2Tampered[0] ^= 0xff;

const secp256r1Vectors = [
  {
    id: "P256-01",
    description: "valid signature, JS-generated keypair and signature",
    public_key_hex: hex(p256Pub1),
    message_hex: hex(p256Msg1),
    signature_hex: hex(p256Sig1),
    expected_valid: true,
  },
  {
    id: "P256-02",
    description: "tampered signature byte, must fail verification",
    public_key_hex: hex(p256Pub2),
    message_hex: hex(p256Msg2),
    signature_hex: hex(p256Sig2Tampered),
    expected_valid: false,
  },
];
writeFileSync(join(OUT_DIR, "secp256r1_vectors.json"), JSON.stringify({ cases: secp256r1Vectors }, null, 2));

console.log("Wrote interop vectors to", OUT_DIR);
