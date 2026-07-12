// Generates a cross-language interop vector for the policy_match/return_chain
// features (Step 7 of plans/verifier-criteria-and-chain-plan.md), from the real,
// built TS package's actual CardVerifier output — not hand-authored expectations.
//
// Unlike the primitive-level vectors (canonicalize/keccak256/hkdf/aes-gcm/mldsa44/
// secp256r1), this exercises the full pipeline: a deterministic multi-card chain,
// a mock RPC/IPFS provider dataset serialized to JSON, and the real CardVerifier's
// computed result (chain + policy_match, per-signature and envelope-level) as the
// "expected" output. Python's test_interop_vectors.py reconstructs generic
// providers from the same dataset and asserts its own CardVerifier produces an
// identical result.
//
// Run with: node scripts/gen-policy-match-chain-vectors.mjs (after `npm run build`)
// Writes vectors/policy_match_chain_vectors.json into ../verifier-py/vectors/

import { writeFileSync } from "node:fs";
import { createCipheriv, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { ml_dsa44 } from "@noble/post-quantum/ml-dsa.js";
import { canonicalize } from "../dist/canonicalize.js";
import { keccak256, hkdfSha3256 } from "../dist/crypto.js";
import { CardVerifier } from "../dist/CardVerifier.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_PATH = join(__dirname, "../../verifier-py/vectors/policy_match_chain_vectors.json");

function b64url(bytes) {
  return Buffer.from(bytes).toString("base64url");
}

// --- Deterministic keypairs (fixed seeds, reproducible across regenerations) ---
function keypair(seedByte) {
  const seed = new Uint8Array(32).fill(seedByte);
  const { secretKey, publicKey } = ml_dsa44.keygen(seed);
  const address = keccak256(publicKey);
  return { secretKey, publicKey, address };
}

const root = keypair(0x01);
const parent = keypair(0x02);
const holder = keypair(0x03); // the "master" card
const sub = keypair(0x04); // the signer for envelope cases
const app = keypair(0x05);
const appCertRoot = keypair(0x06);
const press = keypair(0x07);

function sign(secretKey, data) {
  const sig = ml_dsa44.sign(canonicalize(data), secretKey);
  return b64url(sig);
}

function encryptForCard(pubkey, plaintext) {
  const contentKey = hkdfSha3256(pubkey, "card-content-v1");
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", contentKey, nonce);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([nonce, ciphertext, tag]);
}

function makeCardDoc(recipientPubkey, issuerSk, holderSk, pressSk, ancestryPubkeys, extra = {}) {
  const recipientPubkeyB64 = b64url(recipientPubkey);
  const { publicKey: issuerPub } = ml_dsa44.keygen(new Uint8Array(32).fill(0xaa));
  const { publicKey: pressPub } = ml_dsa44.keygen(new Uint8Array(32).fill(0xbb));

  const offer = {
    policy_id: "QmInteropPolicyCID",
    issuer_card: keccak256(new Uint8Array(issuerPub)),
    press_card: keccak256(new Uint8Array(pressPub)),
    protocol_version: "0.1",
    issued_at: "2026-06-20T00:00:00Z",
    ancestry_pubkeys: ancestryPubkeys,
    ...extra,
  };
  const issuerSig = sign(issuerSk, offer);
  const holderSigInput = { ...offer, issuer_signature: issuerSig, recipient_pubkey: recipientPubkeyB64 };
  const holderSig = sign(holderSk, holderSigInput);
  const pressSigInput = { ...holderSigInput, holder_signature: holderSig };
  const pressSig = sign(pressSk, pressSigInput);
  return { ...pressSigInput, press_signature: pressSig, issuer_signature: issuerSig, holder_signature: holderSig };
}

function makeSubCardDoc(holderPubkey, holderSk, appPubkey, appSk, recipientPubkey) {
  const base = {
    holder_primary_card: keccak256(holderPubkey),
    holder_primary_card_pubkey: b64url(holderPubkey),
    app_card: keccak256(appPubkey),
    app_card_pubkey: b64url(appPubkey),
    capabilities: ["note"],
    recipient_pubkey: b64url(recipientPubkey),
    issued_at: "2026-06-20T00:00:00Z",
    attestation_level: "T2",
  };
  const appSig = sign(appSk, base);
  const holderSigInput = { ...base, app_signature: appSig };
  const holderSig = sign(holderSk, holderSigInput);
  return { ...holderSigInput, holder_signature: holderSig };
}

// --- Build the chain: root (trusted) <- parent <- holder (master) <- sub (signer) ---
const POLICY_CID = "QmInteropPolicyCID";
const parentDoc = makeCardDoc(parent.publicKey, root.secretKey, parent.secretKey, press.secretKey, [b64url(root.publicKey)]);
const masterDoc = {
  ...makeCardDoc(holder.publicKey, parent.secretKey, holder.secretKey, press.secretKey, [b64url(parent.publicKey)]),
  active_subcards: [b64url(sub.publicKey)],
  user_type: "admin",
};
const subDoc = makeSubCardDoc(holder.publicKey, holder.secretKey, app.publicKey, app.secretKey, sub.publicKey);
const appCardDoc = makeCardDoc(app.publicKey, appCertRoot.secretKey, app.secretKey, press.secretKey, [b64url(appCertRoot.publicKey)]);

const PARENT_CID = "QmParentCID";
const MASTER_CID = "QmMasterCID";
const SUB_CID = "QmSubCID";
const APP_CID = "QmAppCID";

const encParentDoc = encryptForCard(parent.publicKey, Buffer.from(JSON.stringify(parentDoc), "utf-8"));
const encMasterDoc = encryptForCard(holder.publicKey, Buffer.from(JSON.stringify(masterDoc), "utf-8"));
const encSubDoc = encryptForCard(sub.publicKey, Buffer.from(JSON.stringify(subDoc), "utf-8"));
const encAppDoc = encryptForCard(app.publicKey, Buffer.from(JSON.stringify(appCardDoc), "utf-8"));

// --- Provider dataset (serializable, replayed identically by both languages) ---
const providerDataset = {
  card_entries: {
    [sub.address]: { log_head_cid: SUB_CID, policy_address: "0x" + "f".repeat(64), last_press_address: press.address, forward_to: null, exists: true },
    [holder.address]: { log_head_cid: MASTER_CID, policy_address: "0x" + "f".repeat(64), last_press_address: press.address, forward_to: null, exists: true },
    [parent.address]: { log_head_cid: PARENT_CID, policy_address: "0x" + "f".repeat(64), last_press_address: press.address, forward_to: null, exists: true },
    [app.address]: { log_head_cid: APP_CID, policy_address: "0x" + "f".repeat(64), last_press_address: press.address, forward_to: null, exists: true },
  },
  policy_authorizers: [root.address, appCertRoot.address],
  press_authorizations: {
    // keyed "<policy_address>|<press_address>" — both card entries above share one policy_address
    ["0x" + "f".repeat(64) + "|" + press.address]: {
      press_public_key: Buffer.from(press.publicKey).toString("hex"),
      mldsa44_key_hash: "0x00",
      active: true,
      authorized_at: "2026-01-01T00:00:00Z",
      revoked_at: null,
    },
  },
  sub_card_entries: {
    [sub.address]: {
      master_card_address: holder.address,
      registration_log_head: "0x",
      sub_card_doc_cid: SUB_CID,
      active: true,
      registered_at: "2026-01-01T00:00:00Z",
      deregistered_at: null,
    },
  },
  ipfs: {
    [PARENT_CID]: b64url(encParentDoc),
    [MASTER_CID]: b64url(encMasterDoc),
    [SUB_CID]: b64url(encSubDoc),
    [APP_CID]: b64url(encAppDoc),
  },
};

// --- Mock providers built from the dataset (same shape both languages must replay) ---
function buildProviders(dataset) {
  const rpc = {
    async getCardEntry(addr) { return dataset.card_entries[addr] ?? null; },
    async isPolicyAuthorizer(addr) { return dataset.policy_authorizers.includes(addr); },
    async getPressAuthorization(policyAddr, pressAddr) {
      return dataset.press_authorizations[`${policyAddr}|${pressAddr}`] ?? null;
    },
    async getSubCardEntry(addr) { return dataset.sub_card_entries[addr] ?? null; },
    async getLogEntries() { return []; },
    async getEasAnnotations() { return []; },
  };
  const ipfs = {
    async fetch(cid) {
      const b64 = dataset.ipfs[cid];
      if (b64 === undefined) throw new Error(`CID not found: ${cid}`);
      return new Uint8Array(Buffer.from(b64, "base64url"));
    },
  };
  return { rpc, ipfs };
}

const payload = { message: "interop vector fixture", protocol_version: "0.1", timestamp: "2026-06-20T00:00:00Z" };
const sig = ml_dsa44.sign(canonicalize(payload), sub.secretKey);
const envelope = {
  payload,
  signatures: [{ public_key: b64url(sub.publicKey), signature: b64url(sig) }],
};

// --- Second, independent signer (non-matching field_match) for the envelope-level OR case ---
const holder2 = keypair(0x13);
const sub2 = keypair(0x14);
const app2 = keypair(0x15);

const masterDoc2 = {
  ...makeCardDoc(holder2.publicKey, parent.secretKey, holder2.secretKey, press.secretKey, [b64url(parent.publicKey)]),
  active_subcards: [b64url(sub2.publicKey)],
  user_type: "member", // deliberately non-matching, so only the first signer satisfies conditions
};
const subDoc2 = makeSubCardDoc(holder2.publicKey, holder2.secretKey, app2.publicKey, app2.secretKey, sub2.publicKey);
const appCardDoc2 = makeCardDoc(app2.publicKey, appCertRoot.secretKey, app2.secretKey, press.secretKey, [b64url(appCertRoot.publicKey)]);

const MASTER2_CID = "QmMaster2CID";
const SUB2_CID = "QmSub2CID";
const APP2_CID = "QmApp2CID";
const encMasterDoc2 = encryptForCard(holder2.publicKey, Buffer.from(JSON.stringify(masterDoc2), "utf-8"));
const encSubDoc2 = encryptForCard(sub2.publicKey, Buffer.from(JSON.stringify(subDoc2), "utf-8"));
const encAppDoc2 = encryptForCard(app2.publicKey, Buffer.from(JSON.stringify(appCardDoc2), "utf-8"));

const envelopeDataset = JSON.parse(JSON.stringify(providerDataset)); // deep clone
Object.assign(envelopeDataset.card_entries, {
  [holder2.address]: { log_head_cid: MASTER2_CID, policy_address: "0x" + "f".repeat(64), last_press_address: press.address, forward_to: null, exists: true },
  [sub2.address]: { log_head_cid: SUB2_CID, policy_address: "0x" + "f".repeat(64), last_press_address: press.address, forward_to: null, exists: true },
  [app2.address]: { log_head_cid: APP2_CID, policy_address: "0x" + "f".repeat(64), last_press_address: press.address, forward_to: null, exists: true },
});
Object.assign(envelopeDataset.sub_card_entries, {
  [sub2.address]: { master_card_address: holder2.address, registration_log_head: "0x", sub_card_doc_cid: SUB2_CID, active: true, registered_at: "2026-01-01T00:00:00Z", deregistered_at: null },
});
Object.assign(envelopeDataset.ipfs, {
  [MASTER2_CID]: b64url(encMasterDoc2),
  [SUB2_CID]: b64url(encSubDoc2),
  [APP2_CID]: b64url(encAppDoc2),
});

const sig2 = ml_dsa44.sign(canonicalize(payload), sub2.secretKey);
const combinedEnvelope = {
  payload,
  signatures: [
    { public_key: b64url(sub.publicKey), signature: b64url(sig) },
    { public_key: b64url(sub2.publicKey), signature: b64url(sig2) },
  ],
};

const cases = [];

async function buildCase(id, description, conditions) {
  const { rpc, ipfs } = buildProviders(providerDataset);
  const verifier = new CardVerifier({
    rpc,
    ipfs,
    trustedRoots: [root.address],
    appCertificationRoot: appCertRoot.address,
    returnChain: true,
    conditions,
  });
  const result = await verifier.verifyEnvelope(envelope);
  cases.push({
    id,
    description,
    provider_dataset: providerDataset,
    envelope,
    config: {
      trusted_roots: [root.address],
      app_certification_root: appCertRoot.address,
      return_chain: true,
      conditions: conditions ?? null,
    },
    expected: {
      envelope_policy_match: result.policy_match,
      signature_policy_match: result.signatures[0].policy_match,
      chain: result.signatures[0].chain,
    },
  });
}

await buildCase("PMC-01", "matching policy_id + matching field_match -> true", {
  policy_id: POLICY_CID,
  field_match: { user_type: "admin" },
});
await buildCase("PMC-02", "matching policy_id, non-matching field_match -> false", {
  policy_id: POLICY_CID,
  field_match: { user_type: "member" },
});
await buildCase("PMC-03", "non-matching policy_id -> false", {
  policy_id: "QmSomeOtherPolicyNotInChain",
});
await buildCase("PMC-04", "no conditions supplied -> null, chain still returned", undefined);

// --- PMC-05: envelope-level OR across two signers, only one matching ---
{
  const conditions = { policy_id: POLICY_CID, field_match: { user_type: "admin" } };
  const { rpc, ipfs } = buildProviders(envelopeDataset);
  const verifier = new CardVerifier({
    rpc,
    ipfs,
    trustedRoots: [root.address],
    appCertificationRoot: appCertRoot.address,
    returnChain: true,
    conditions,
  });
  const result = await verifier.verifyEnvelope(combinedEnvelope);
  cases.push({
    id: "PMC-05",
    description: "envelope-level policy_match is OR across two signers (one matches, one doesn't)",
    provider_dataset: envelopeDataset,
    envelope: combinedEnvelope,
    config: {
      trusted_roots: [root.address],
      app_certification_root: appCertRoot.address,
      return_chain: true,
      conditions,
    },
    expected: {
      envelope_policy_match: result.policy_match,
      per_signature_policy_match: result.signatures.map((s) => s.policy_match),
      chains: result.signatures.map((s) => s.chain),
    },
  });
}

writeFileSync(OUT_PATH, JSON.stringify({ cases }, null, 2));
console.log(`Wrote ${cases.length} cases to ${OUT_PATH}`);
