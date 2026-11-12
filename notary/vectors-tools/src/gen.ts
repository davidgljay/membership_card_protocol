/**
 * Generates notary/vectors/ — the committed cross-language contract (code-plan §7.2, Q5).
 *
 *   node --experimental-strip-types src/gen.ts           write the files
 *   node --experimental-strip-types src/gen.ts --check   fail if committed files differ (CI)
 *
 * Everything is deterministic: fixed seeds, deterministic ML-DSA signing. The Rust side
 * (notary-types/tests/vectors.rs) parses each `input`, re-serializes, and must reproduce the
 * committed bytes, hashes and verdicts; it never regenerates them.
 *
 * Implements: protocol-objects.md §20–§34 canonical forms, §27 Merkle, §33 user_data.
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sha256 } from "@noble/hashes/sha256";
import { ml_dsa44 } from "@noble/post-quantum/ml-dsa.js";
import { hpkeSuite, sealedInputInfoAad, RECEIPT_EXPORT_CONTEXT } from "./hpke.ts";
import {
  b64uEncode, b64uDecode, canonicalNotary, parseCanonicalNotary, H, withoutFields, cardPointer, cidFromDigest, digestFromCid,
  parseTimestamp, parseDuration, inputCommitment, encodeUserData, assertNotaryObject, assertCardPointer, NotaryFormatError,
} from "@membership-card-protocol/verifier/notary";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "vectors");
const CHECK = process.argv.includes("--check");
const files = new Map<string, string>();
const put = (rel: string, data: unknown) => files.set(rel, JSON.stringify(data, null, 2) + "\n");

const te = new TextEncoder();
const utf8 = (b: Uint8Array) => new TextDecoder().decode(b);
const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
const fill = (n: number, len: number) => new Uint8Array(len).map((_, i) => (n * 31 + i * 7) & 255);
const code = (f: () => unknown): string => { try { f(); return "ok"; } catch (e) { if (e instanceof NotaryFormatError) return e.code; throw e; } };

// ---- deterministic keys and signatures -----------------------------------------------------

const keys = new Map<number, { publicKey: Uint8Array; secretKey: Uint8Array }>();
function kp(n: number) {
  if (!keys.has(n)) keys.set(n, ml_dsa44.keygen(sha256(te.encode(`card-notary-vector-key-${n}`))));
  return keys.get(n)!;
}
const pub = (n: number) => b64uEncode(kp(n).publicKey);
const card = (n: number) => cardPointer(kp(n).publicKey);
function sign(n: number, unsigned: Record<string, unknown>) {
  const sig = ml_dsa44.sign(canonicalNotary(unsigned), kp(n).secretKey, { extraEntropy: false });
  return { public_key: pub(n), signature: b64uEncode(sig) };
}
const cid = (tag: string) => cidFromDigest(sha256(te.encode(tag)));
const b = (tag: string, len = 32) => b64uEncode(fill(tag.length + tag.charCodeAt(0), len));

// ---- fixtures: one valid instance of every object ------------------------------------------

const T0 = "2026-11-12T10:00:00Z";
function build() {
  const policyId = cid("policy"), jobKeys = { job_public_key: b64uEncode(fill(9, 1216)) };

  const genesis_request = {
    chain_pubkey: b64uEncode(fill(5, 64)), id_pubkey: pub(1), nonce: b64uEncode(fill(6, 16)), operator_card: card(2),
    operator_host_pubkey: pub(3), platform: "aws-nitro-enclaves", policy_id: policyId, requested_at: T0, type: "notary.genesis_request.v1",
  };

  const jobUnsigned = {
    closes_at: "2026-11-19T10:00:00Z", created_at: T0, kem: "x-wing-draft-06", min_live: 2, nonce: b64uEncode(fill(7, 16)),
    opens_at: T0, parameters: { question: "Adopt the budget?" }, policy_id: policyId, policy_state_cid: cid("policy-state"),
    replica_set: [{ instances: 3, notary_card: card(1) }], requester_card: card(4), requester_pubkey: pub(4),
    requester_text: "Vote before Friday", type: "notary.job.v1",
  };
  const job = { ...jobUnsigned, requester_signature: sign(4, jobUnsigned) };
  const jobHash = H(job);

  const annUnsigned = {
    attestations: [cid("att-1"), cid("att-2")], epoch: 0, issued_at: T0, job, ...jobKeys,
    transport: { key_config_url: "https://notary.example/ohttp/key-config", relay_target_id: "notary-a" }, type: "notary.announcement.v1",
  };
  const announcement = { ...annUnsigned, notary_signature: sign(1, annUnsigned) };

  const inputUnsigned = {
    chain_ref: { block_hash: b("blk"), block_number: 123456 }, contributor_card: card(5), contributor_card_pubkey: pub(5),
    evidence: [{ bytes: b64uEncode(te.encode("{\"example\":true}")), cid: cid("evidence-1") }], job_hash: jobHash,
    payload: { choice: "yes" }, revision: 0, signed_at: T0, type: "notary.input.v1",
  };
  const input = { ...inputUnsigned, contributor_signature: sign(6, inputUnsigned) };

  const countersign = { holder_signature: b64uEncode(fill(3, 2420)), job_hash: jobHash, offer_hash: b("offer"), type: "notary.countersign.v1" };
  const sealed_input = { ct: b64uEncode(fill(4, 300)), enc: b64uEncode(fill(8, 1120)), epoch: 0, job_hash: jobHash, kem: "x-wing-draft-06", type: "notary.sealed_input.v1" };
  const inputHash = H(sealed_input);

  const hrUnsigned = { epoch: 0, input_hash: inputHash, job_hash: jobHash, notary_card: card(1), received_at: T0, type: "notary.host_receipt.v1" };
  const host_receipt = { ...hrUnsigned, host_signature: sign(3, hrUnsigned) };

  const vrUnsigned = { acks: 2, epoch: 0, input_hash: inputHash, instance: b("inst"), job_hash: jobHash, processed_at: T0, revision: 1, status: "accepted", type: "notary.validation_receipt.v1" };
  const validation_receipt = { ...vrUnsigned, notary_signature: sign(1, vrUnsigned) };
  const vrRejUnsigned = { ...vrUnsigned, reject_reason: "INPUT_NOT_ELIGIBLE", status: "rejected" };
  const validation_receipt_rejected = { ...vrRejUnsigned, notary_signature: sign(1, vrRejUnsigned) };

  const nUnsigned = {
    accepted: 42, attestation: cid("att-close"), chain_state: { block_hash: b("blk2"), block_number: 123999, block_timestamp: "2026-11-19T10:00:03Z", state_root: b("root") },
    close_quorum: 2, closed_at: "2026-11-19T10:00:03Z",
    cosignatures: [{ attestation: cid("att-c1"), instance_signature: sign(7, { body: "placeholder-1" }) }, { attestation: cid("att-c2"), instance_signature: sign(8, { body: "placeholder-2" }) }],
    counted_inputs: cid("counted"), dropped_after_acceptance: 0, final_epoch: 0, input_commitment: b("commit"), job_cid: cid("job"), job_hash: jobHash,
    job_log_head: cid("log-head"), notary_card: card(1), output: { public: { abstain: 3, no: 12, yes: 27 } }, output_hash: b("out"),
    platform: "aws-nitro-enclaves", policy_id: policyId, policy_state_cid: cid("policy-state"), program_cid: cid("program"),
    rejected: 4, suppressed: false, type: "notary.notarization.v1",
  };
  const notarization = { ...nUnsigned, notary_signature: sign(1, nUnsigned) };

  const jlUnsigned = { at: T0, body: { accepted: 42, input_commitment: b("commit"), notarization: cid("notarization"), rejected: 4 }, instance: b("inst"), job_hash: jobHash, kind: "notarized", prev: cid("log-prev"), seq: 7, type: "notary.job_log.v1" };
  const job_log = { ...jlUnsigned, notary_signature: sign(1, jlUnsigned), instance_signature: sign(7, jlUnsigned) };
  const ilUnsigned = { at: T0, body: { replaced: true }, instance: b("inst"), job_hash: card(1), kind: "handoff", seq: 0, type: "notary.identity_log.v1" };
  const identity_log = { ...ilUnsigned, notary_signature: sign(1, ilUnsigned), instance_signature: sign(7, ilUnsigned) };

  const hoUnsigned = {
    at: T0, epoch: 0, from_attestation: cid("ho-from"), from_instance: b("from"), job_hash: jobHash, pcr0_from: b("pcr-a", 48), pcr0_to: b("pcr-b", 48),
    scope: "job", state_hash: b("state"), state_version: 5, to_attestation: cid("ho-to"), to_instance: b("to"), to_notary_card: card(1), type: "notary.handoff.v1",
  };
  const handoff = { ...hoUnsigned, receiver_signature: sign(8, hoUnsigned) };

  const hbUnsigned = {
    chain_head: { block_hash: b("blk3"), block_number: 124000 }, identity_state_version: 3, instance: b("inst"),
    jobs: [{ epoch: 0, job_hash: jobHash, state_version: 5 }], list_versions: { accepted_runtimes: 2, program_allowlist: 4 },
    peers_seen: [b("peer-1"), b("peer-2")], seq: 99, type: "notary.heartbeat.v1",
  };
  const heartbeat = { ...hbUnsigned, instance_signature: sign(7, hbUnsigned) };

  const sbUnsigned = { at: T0, body_cid: cid("blob-body"), body_hash: b("body"), notary_card: card(1), prev_hash: b("prev"), type: "notary.state_blob.v1", version: 4 };
  const state_blob = { ...sbUnsigned, notary_signature: sign(1, sbUnsigned) };

  const propagation_batch = {
    batch_seq: 2, chain_payload: { op: "BatchUpdateCardHeads", count: 1 }, chain_signature: b64uEncode(fill(2, 64)),
    entries: [{ card_address: card(9), log_entry_cid: cid("rev-1"), prev_log_cid: cid("prev-1") }], notary_card: card(1),
    policy_id: policyId, release_not_before: "2026-11-13T06:00:00Z", type: "notary.propagation_batch.v1",
  };

  const laUnsigned = {
    governance_version: 3, kind: "standard", list: "accepted_runtimes", list_card: card(10), list_hash: b("list"), list_version: 2,
    prev_list_hash: b("list-prev"), type: "notary_list_approval",
  };
  const list_approval = { ...laUnsigned, signatures: [{ key_index: 0, signature: b64uEncode(fill(1, 64)) }, { key_index: 2, signature: b64uEncode(fill(2, 64)) }] };

  return {
    genesis_request, job, announcement, input, countersign, sealed_input, host_receipt, validation_receipt, validation_receipt_rejected,
    notarization, job_log, identity_log, handoff, heartbeat, state_blob, propagation_batch, list_approval,
  } as Record<string, Record<string, unknown>>;
}

// ---- objects/ -------------------------------------------------------------------------------

const SIG_FIELDS: Record<string, string[]> = {
  job: ["requester_signature"], announcement: ["notary_signature"], input: ["contributor_signature"], host_receipt: ["host_signature"],
  validation_receipt: ["notary_signature"], validation_receipt_rejected: ["notary_signature"], notarization: ["notary_signature"],
  job_log: ["notary_signature", "instance_signature"], identity_log: ["notary_signature", "instance_signature"], handoff: ["receiver_signature"],
  heartbeat: ["instance_signature"], state_blob: ["notary_signature"],
};
const SIGNER: Record<string, number> = {
  job: 4, announcement: 1, input: 6, host_receipt: 3, validation_receipt: 1, validation_receipt_rejected: 1, notarization: 1,
  job_log: 1, identity_log: 1, handoff: 8, heartbeat: 7, state_blob: 1,
};

function objectVectors() {
  const objs = build();
  for (const [name, obj] of Object.entries(objs)) {
    const canon = canonicalNotary(obj);
    const type = obj["type"] as string;
    assertNotaryObject(obj, type);
    const c: Record<string, unknown> = {
      id: name, description: `${type} — valid instance`, type, input: obj, canonical_utf8: utf8(canon), canonical_b64u: b64uEncode(canon),
      h: H(obj), cid: cidFromDigest(sha256(canon)),
    };
    const sf = SIG_FIELDS[name];
    if (sf) {
      const unsigned = withoutFields(obj, ...sf);
      c["signing_bytes_b64u"] = b64uEncode(canonicalNotary(unsigned));
      c["signature_checks"] = sf.map((f) => ({ field: f, signer_public_key: (obj[f] as { public_key: string }).public_key, scheme: "ml-dsa-44", context: "" }));
      c["signing_bytes_note"] = "each signature is over the canonical JSON of the object without ALL of its signature fields; notarization cosignatures are structural placeholders (erratum E6: the signed form of H(body) is unspecified)";
    }
    put(`objects/${name}.json`, { object: type, cases: [c] });
  }
  // rejects: shared negative cases
  const sealed = objs["sealed_input"]!;
  const rejects = [
    { id: "R-null", description: "null is never allowed", text: '{"a":null}', expected: "JSON_NULL" },
    { id: "R-float", description: "non-integer number", text: '{"a":1.5}', expected: "JSON_NON_INTEGER" },
    { id: "R-float-int", description: "exponent form (a float token; JS reads it as integer 100 and finds it non-canonical, Rust reads a float)", text: '{"a":1e2}', expected: "JSON_NOT_CANONICAL", expected_any: ["JSON_NOT_CANONICAL", "JSON_NON_INTEGER"] },
    { id: "R-unsafe-int", description: "integer beyond 2^53-1", text: '{"a":9007199254740992}', expected: "JSON_INTEGER_RANGE" },
    { id: "R-unsorted", description: "keys not sorted", text: '{"b":1,"a":2}', expected: "JSON_NOT_CANONICAL" },
    { id: "R-whitespace", description: "whitespace", text: '{"a": 1}', expected: "JSON_NOT_CANONICAL" },
    { id: "R-duplicate-key", description: "duplicate keys collapse, so bytes are not canonical", text: '{"a":1,"a":1}', expected: "JSON_NOT_CANONICAL" },
    { id: "R-escape", description: "needless escape of a printable character", text: '{"a":"\\u0041"}', expected: "JSON_NOT_CANONICAL" },
  ].map((r) => ({ ...r, observed_ts: code(() => parseCanonicalNotary(te.encode(r.text))) }));
  for (const r of rejects) if (r.observed_ts !== r.expected) throw new Error(`reject ${r.id}: TS gave ${r.observed_ts}, expected ${r.expected}`);
  const objRejects = [
    { id: "R-unknown-field", description: "extra top-level field on a versioned object", object: { ...sealed, extra: 1 }, expected_type: "notary.sealed_input.v1", expected: "UNKNOWN_FIELD" },
    { id: "R-missing-field", description: "required field absent", object: withoutFields(sealed, "enc"), expected_type: "notary.sealed_input.v1", expected: "MISSING_FIELD" },
    { id: "R-wrong-type", description: "type is another object's", object: sealed, expected_type: "notary.job.v1", expected: "TYPE_MISMATCH" },
  ].map((r) => ({ ...r, observed_ts: code(() => assertNotaryObject(r.object, r.expected_type)) }));
  for (const r of objRejects) if (r.observed_ts !== r.expected) throw new Error(`reject ${r.id}: TS gave ${r.observed_ts}`);
  put("objects/rejects.json", { json: rejects.map(({ observed_ts: _, ...r }) => r), objects: objRejects.map(({ observed_ts: _, ...r }) => r) });
}

// ---- formats.json ----------------------------------------------------------------------------

function formatVectors() {
  const bytes = [0, 1, 2, 3, 32].map((n) => fill(n + 1, n));
  const b64 = bytes.map((x) => ({ hex: hex(x), b64u: b64uEncode(x) }));
  const b64Bad = [
    { id: "padded", value: "AA==", expected: "BASE64URL_INVALID" }, { id: "trailing-bits", value: "AB", expected: "BASE64URL_INVALID" },
    { id: "bad-length", value: "A", expected: "BASE64URL_INVALID" }, { id: "std-alphabet", value: "A+AA", expected: "BASE64URL_INVALID" },
  ];
  for (const r of b64Bad) if (code(() => b64uDecode(r.value)) !== r.expected) throw new Error(`b64 ${r.id}`);
  const ts = ["2026-11-12T10:00:00Z", "2026-11-12T10:00:00.5Z", "2024-02-29T23:59:59.999Z", "1970-01-01T00:00:00Z"].map((s) => ({ value: s, ms: parseTimestamp(s) }));
  const tsBad = ["2026-11-12T10:00:00+00:00", "2026-02-30T00:00:00Z", "2026-11-12 10:00:00Z", "2026-11-12T24:00:00Z", "2026-11-12T10:00Z", "2026-11-12T10:00:00.1234Z", "2025-02-29T00:00:00Z"]
    .map((s) => ({ value: s, expected: "TIMESTAMP_INVALID" }));
  for (const r of tsBad) if (code(() => parseTimestamp(r.value)) !== r.expected) throw new Error(`ts ${r.value}`);
  const dur = ["P7D", "P2D", "PT6H", "PT24H", "P1W", "P1DT2H3M4S", "PT90S"].map((s) => ({ value: s, ms: parseDuration(s) }));
  const durBad = ["P1Y", "P1M", "P", "PT", "7D", "P1DT", "PT1H1D", "P1D1W", "PT1.5H"].map((s) => ({ value: s, expected: "DURATION_INVALID" }));
  for (const r of durBad) if (code(() => parseDuration(r.value)) !== r.expected) throw new Error(`dur ${r.value}`);
  const cids = ["a", "b", "c"].map((t) => { const d = sha256(te.encode(t)); return { digest_hex: hex(d), cid: cidFromDigest(d) }; });
  for (const c of cids) if (hex(digestFromCid(c.cid)) !== c.digest_hex) throw new Error("cid round trip");
  const cidBad = [{ value: "z" + cids[0]!.cid.slice(1) }, { value: cids[0]!.cid.slice(0, -1) }, { value: cids[0]!.cid.toUpperCase() }, { value: "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi" }]
    .map((r) => ({ ...r, expected: "CID_INVALID" }));
  for (const r of cidBad) if (code(() => digestFromCid(r.value)) !== "CID_INVALID") throw new Error(`cid ${r.value}`);
  const pk = kp(1).publicKey;
  const pointers = { public_key_b64u: b64uEncode(pk), card_pointer: cardPointer(pk) };
  const pointerBad = ["0x" + cardPointer(pk), cardPointer(pk).toUpperCase(), cardPointer(pk).slice(2)];
  for (const p of pointerBad) if (code(() => assertCardPointer(p)) !== "CARD_POINTER_INVALID") throw new Error("pointer");
  put("formats.json", { base64url: { valid: b64, invalid: b64Bad }, timestamp: { valid: ts, invalid: tsBad }, duration: { valid: dur, invalid: durBad }, cid: { valid: cids, invalid: cidBad }, card_pointer: { valid: pointers, invalid: pointerBad } });
}

// ---- merkle, user_data ------------------------------------------------------------------------

function merkleVectors() {
  const mk = (n: number) => Array.from({ length: n }, (_, i) => { const h = new Uint8Array(32); h[0] = (i + 1) >> 8; h[1] = (i + 1) & 255; h[31] = i; return h; });
  const cases = [0, 1, 2, 3, 4, 5, 7, 8, 9].map((n) => ({
    id: `M-${n}`, description: n === 0 ? "empty list: SHA-256 of the empty string (erratum E1)" : `${n} input hash(es)`,
    input_hashes_b64u: mk(n).map(b64uEncode), root_b64u: b64uEncode(inputCommitment(mk(n))),
  }));
  const bad = [{ id: "M-unsorted", input_hashes_b64u: [b64uEncode(mk(2)[1]!), b64uEncode(mk(2)[0]!)], expected: "MERKLE_UNSORTED" },
    { id: "M-duplicate", input_hashes_b64u: [b64uEncode(mk(1)[0]!), b64uEncode(mk(1)[0]!)], expected: "MERKLE_UNSORTED" }];
  put("objects/merkle.json", { cases, invalid: bad });
}

function userDataVectors() {
  const h = (n: number) => fill(n, 32);
  const cases = [
    { id: "UD-genesis", purpose: 1, f: { idKeyHash: h(1), chainKeyHash: h(2), instKeyHash: h(3) } },
    { id: "UD-job", purpose: 2, f: { idKeyHash: h(1), instKeyHash: h(3), programHash: h(4), jobHash: h(5), epoch: 258n, isolation: 1 } },
    { id: "UD-instance", purpose: 3, f: { instKeyHash: h(3) } },
    { id: "UD-admitted", purpose: 4, f: { idKeyHash: h(1), instKeyHash: h(3), programHash: h(4), jobHash: h(5), epoch: 0xffffffffffffn, isolation: 2 } },
  ].map(({ id, purpose, f }) => {
    const ud = encodeUserData({ purpose: purpose as 1, ...(f as object) });
    const fields = Object.fromEntries(Object.entries(f).map(([k, v]) => [k, typeof v === "bigint" ? v.toString() : v instanceof Uint8Array ? b64uEncode(v) : v]));
    return { id, purpose, fields, user_data_hex: hex(ud) };
  });
  const base = encodeUserData({ purpose: 1, instKeyHash: h(3) });
  const mut = (f: (x: Uint8Array) => void) => { const x = base.slice(); f(x); return hex(x); };
  const bad = [
    { id: "UD-short", user_data_hex: hex(base.slice(0, 180)) }, { id: "UD-long", user_data_hex: hex(Uint8Array.from([...base, 0])) },
    { id: "UD-tag", user_data_hex: mut((x) => { x[0] = 0x58; }) }, { id: "UD-version", user_data_hex: mut((x) => { x[10] = 2; }) },
    { id: "UD-purpose-0", user_data_hex: mut((x) => { x[11] = 0; }) }, { id: "UD-purpose-5", user_data_hex: mut((x) => { x[11] = 5; }) },
    { id: "UD-isolation-3", user_data_hex: mut((x) => { x[180] = 3; }) },
  ].map((r) => ({ ...r, expected: "ATT_USER_DATA_MALFORMED" }));
  put("user_data/layouts.json", { length: 181, cases, invalid: bad });
}

// ---- attestation/notarization_spec.json: inputs for the Rust simulator to build cosigner attestations -----

function notarizationSpec() {
  const o = build();
  const job = o["job"]!;
  put("attestation/notarization_spec.json", {
    note: "Inputs for notary/sim/tests/notarization_fixtures.rs: the job, program and replica instance keys the notarization tests (verifier test/notary/notarization.test.ts) use.",
    job_hash: H(job), program_cid: cid("program"), final_epoch: 0, isolation: 1, notary_card: card(1),
    instance_public_keys: [7, 8, 9].map(pub), timestamp: "2026-11-19T10:00:03Z",
  });
}

// ---- signatures.json: ML-DSA-44 pure mode, empty context ---------------------------------------

function signatureVectors() {
  const msgs = ["", "card-notary", "{\"a\":1}"].map(te.encode.bind(te));
  const cases = msgs.map((m, i) => {
    const k = kp(20 + i);
    return { id: `SIG-${i}`, seed_b64u: b64uEncode(sha256(te.encode(`card-notary-vector-key-${20 + i}`))), public_key_b64u: b64uEncode(k.publicKey), message_b64u: b64uEncode(m),
      signature_b64u: b64uEncode(ml_dsa44.sign(m, k.secretKey, { extraEntropy: false })) };
  });
  put("signatures.json", { scheme: "ML-DSA-44 (FIPS 204, pure mode, empty context)", signer: "@noble/post-quantum, deterministic", cases });
}


// ---- xwing/js_vectors.json: X-Wing draft-06 HPKE, fixed seeds (CP9 checkpoint 1) -----------------
// Suite per §24: KEM X-Wing draft-06 (0x647a), KDF HKDF-SHA256, AEAD ChaCha20-Poly1305, base mode.

async function xwingVectors() {
  const suite = hpkeSuite();
  const cases = [];
  for (let n = 0; n < 3; n++) {
    const seed = sha256(te.encode(`card-notary-xwing-seed-${n}`));
    const ekm = Uint8Array.from([...sha256(te.encode(`card-notary-xwing-ekm-a-${n}`)), ...sha256(te.encode(`card-notary-xwing-ekm-b-${n}`))]);
    const jobHash = sha256(te.encode(`job-${n}`));
    const epoch = n;
    const pt = n === 0 ? te.encode("") : canonicalNotary({ type: "notary.input.v1", n, payload: { choice: "yes" } });
    const { info, aad } = sealedInputInfoAad(jobHash, epoch);
    const pair = await suite.kem.deriveKeyPair(seed);
    const sk = new Uint8Array(await suite.kem.serializePrivateKey(pair.privateKey));
    const pk = new Uint8Array(await suite.kem.serializePublicKey(pair.publicKey));
    const sender = await suite.createSenderContext({ recipientPublicKey: pair.publicKey, info, ekm });
    const ct = new Uint8Array(await sender.seal(pt, aad));
    const exported = new Uint8Array(await sender.export(te.encode(RECEIPT_EXPORT_CONTEXT), 32));
    cases.push({
      id: `XW-${n}`, seed_b64u: b64uEncode(seed), sk_b64u: b64uEncode(sk), pk_b64u: b64uEncode(pk), ekm_b64u: b64uEncode(ekm),
      job_hash_b64u: b64uEncode(jobHash), epoch, info_b64u: b64uEncode(info), aad_b64u: b64uEncode(aad), pt_b64u: b64uEncode(pt),
      enc_b64u: b64uEncode(new Uint8Array(sender.enc)), ct_b64u: b64uEncode(ct), export_context: RECEIPT_EXPORT_CONTEXT, exported_b64u: b64uEncode(exported),
    });
  }
  put("xwing/js_vectors.json", {
    suite: { kem: "X-Wing draft-06 (0x647a)", kdf: "HKDF-SHA256", aead: "ChaCha20-Poly1305", mode: "base" },
    producer: "@hpke/hybridkem-x-wing 0.7.1 + @hpke/core 1.10.1 + @hpke/chacha20poly1305 1.8.1",
    note: "ekm is the 64-byte encapsulation randomness; the Rust side must reproduce enc, ct and exported bit for bit",
    cases,
  });
}

// ---- run ----------------------------------------------------------------------------------------

objectVectors(); formatVectors(); merkleVectors(); userDataVectors(); signatureVectors(); notarizationSpec(); await xwingVectors();

let stale = 0;
for (const [rel, text] of files) {
  const path = join(ROOT, rel);
  if (CHECK) {
    if (!existsSync(path) || readFileSync(path, "utf8") !== text) { console.error(`STALE: vectors/${rel}`); stale++; }
  } else {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  }
}
if (CHECK) { if (stale) process.exit(1); console.log(`vectors up to date (${files.size} files)`); } else console.log(`wrote ${files.size} files to ${ROOT}`);
