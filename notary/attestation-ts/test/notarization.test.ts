import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { sha256 } from "@noble/hashes/sha256";
import { ml_dsa44 } from "@noble/post-quantum/ml-dsa.js";
import { b64uDecode, b64uEncode, canonicalNotary, cardPointer, cidOfBytes, H, inputCommitment, publicOutputValid, verifyNotarization, withoutFields } from "@membership-card-protocol/verifier/notary";
import type { NotarizationReads, NotarizationConfig, NotarySection, AcceptedRuntime } from "@membership-card-protocol/verifier/notary";
import { awsNitroEnclaves, simulator } from "../src/index.ts";

const VEC = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "vectors");
const load = (f: string) => JSON.parse(readFileSync(join(VEC, f), "utf8"));
const te = new TextEncoder();
const key = (n: number) => ml_dsa44.keygen(sha256(te.encode(`card-notary-vector-key-${n}`)));
const pub = (n: number) => b64uEncode(key(n).publicKey);
const signObj = (n: number, unsigned: object) => ({ public_key: pub(n), signature: b64uEncode(ml_dsa44.sign(canonicalNotary(unsigned), key(n).secretKey, { extraEntropy: false })) });
const signDigest = (n: number, digest: Uint8Array) => ({ public_key: pub(n), signature: b64uEncode(ml_dsa44.sign(digest, key(n).secretKey, { extraEntropy: false })) });

const spec = load("attestation/notarization_spec.json");
const att = load("attestation/notarization_attestations.json");
const job = load("objects/job.json").cases[0].input as Record<string, any>;
const NOTARY_CARD: string = spec.notary_card;
const CLOSED_AT = "2026-11-19T10:00:03Z";
const T = (s: string) => Date.parse(s);

const notary: NotarySection = {
  contributor_predicate: { issued_under_template: "x" }, input_replacement: "latest_wins", input_schema: [], isolation: "shared", mode: "aggregate",
  output_action: "statement", output_schema: [
    { name: "yes", type: "integer", clamp: [0, 1000], round_to: 1 }, { name: "no", type: "integer" }, { name: "abstain", type: "integer", required: false, suppress_cell_below_k: 2 },
  ], platform: "simulator", privacy: { k_min: 5 }, program_cid: spec.program_cid, retention: "none",
};
const accepted: AcceptedRuntime[] = [{ accepted_from: "2026-01-01T00:00:00Z", build_recipe_cid: "x", close_compat: "c", pcr0: att.accepted_pcr0, platform: "simulator", source_commit: "s", version: "1" }];
const cfg: NotarizationConfig = { attest: { roots: { simulator: b64uDecode(att.trust_root) }, allowSimulator: true }, modules: [simulator, awsNitroEnclaves], acceptedRuntimes: accepted };

const jobBytes = canonicalNotary(job);
const JOB_CID = cidOfBytes(jobBytes);
const docCid = (name: string) => cidOfBytes(b64uDecode(att.docs[name]));
const store = new Map<string, Uint8Array>();
const put = (bytes: Uint8Array) => { const c = cidOfBytes(bytes); store.set(c, bytes); return c; };
put(jobBytes);
for (const n of Object.keys(att.docs)) put(b64uDecode(att.docs[n]));

const counted = Array.from({ length: 42 }, (_, i) => { const h = new Uint8Array(32); h[0] = 0; h[1] = i + 1; return h; });
const COUNTED_CID = put(canonicalNotary(counted.map(b64uEncode)));
const COMMIT = b64uEncode(inputCommitment(counted));

interface World { notarization: Record<string, any>; cid: string; anchors: { seq: number; record_cid: string; timestamp: number }[]; reads: NotarizationReads }

function logRecord(seq: number, kind: string, body: object, prev?: string, over: Record<string, unknown> = {}) {
  const u: Record<string, unknown> = { at: "2026-11-12T10:00:00Z", body, instance: b64uEncode(sha256(key(7).publicKey)), job_hash: spec.job_hash, kind, seq, type: "notary.job_log.v1", ...(prev ? { prev } : {}), ...over };
  const rec = { ...u, notary_signature: signObj(1, u), instance_signature: signObj(7, u) };
  const cid = put(canonicalNotary(rec));
  return { rec, cid };
}

function world(o: {
  patch?: (n: Record<string, any>) => void; cosigs?: string[]; reads?: Partial<NotarizationReads>; policy?: Partial<{ notary: NotarySection; approvedNotaries: string[]; chainValid: boolean }>;
  extraAnchors?: (log: { cid: string }[]) => { seq: number; record_cid: string; timestamp: number }[]; dropRecord?: boolean; totalLoss?: boolean; cosigDigestOverText?: boolean; closerDoc?: string; resign?: boolean;
} = {}): World {
  const r0 = logRecord(0, "opened", { attestations: [] });
  const r1 = o.totalLoss ? logRecord(1, "epoch_started", { epoch: 0, epoch_reason: "total_loss" }, r0.cid) : logRecord(1, "replicated", { instance: "x", attestation: docCid("cosig_1") }, r0.cid);
  if (o.dropRecord) store.delete(r0.cid);
  const cosigDocs = o.cosigs ?? ["closer", "cosig_1", "cosig_2"];
  const instKeys: Record<string, number> = { closer: 7, cosig_1: 8, cosig_2: 9, cosig_1_wrong_instance: 8, cosig_1_stranger_id: 8 };
  const body: Record<string, any> = {
    accepted: 42, attestation: docCid(o.closerDoc ?? "closer"), chain_state: { block_hash: b64uEncode(sha256(te.encode("blk"))), block_number: 123999, block_timestamp: CLOSED_AT, state_root: b64uEncode(sha256(te.encode("root"))) },
    close_quorum: 2, closed_at: CLOSED_AT, counted_inputs: COUNTED_CID, dropped_after_acceptance: 0, final_epoch: 0, input_commitment: COMMIT, job_cid: JOB_CID, job_hash: spec.job_hash,
    job_log_head: r1.cid, notary_card: NOTARY_CARD, output: { public: { abstain: 3, no: 12, yes: 27 } }, output_hash: H({ abstain: 3, no: 12, yes: 27 }),
    platform: "simulator", policy_id: job["policy_id"], policy_state_cid: job["policy_state_cid"], program_cid: spec.program_cid, rejected: 4, suppressed: false, type: "notary.notarization.v1",
  };
  o.patch?.(body);
  const digest = sha256(canonicalNotary(body));
  const cosignatures = cosigDocs.map((d) => ({ attestation: docCid(d), instance_signature: o.cosigDigestOverText ? signDigest(instKeys[d]!, te.encode(b64uEncode(digest))) : signDigest(instKeys[d]!, digest) }));
  const unsignedFull = { ...body, cosignatures };
  const notarization = { ...unsignedFull, notary_signature: signObj(1, unsignedFull) };
  const cid = put(canonicalNotary(notarization));
  const notarizedRec = logRecord(2, "notarized", { accepted: 42, input_commitment: COMMIT, notarization: cid, rejected: 4 }, r1.cid);
  const base = [{ seq: 0, record_cid: r0.cid, timestamp: T("2026-11-12T10:00:10Z") }, { seq: 2, record_cid: notarizedRec.cid, timestamp: T("2026-11-19T10:05:00Z") }];
  const anchors = [...base, ...(o.extraAnchors?.([r0, r1, notarizedRec]) ?? [])];
  const reads: NotarizationReads = {
    nowMs: () => T("2026-11-19T11:00:00Z"),
    fetch: async (c) => store.get(c) ?? null,
    policyAt: async () => ({ notary, approvedNotaries: [NOTARY_CARD], chainValid: true, ...o.policy }),
    notaryCard: async () => ({ recipientPubkey: pub(1), chainValid: true }),
    block: async (n) => (n === 123999 ? { hash: body["chain_state"].block_hash, timestampMs: T(CLOSED_AT) } : null),
    keyExposure: async () => "none",
    anchors: async () => anchors,
    ...o.reads,
  };
  return { notarization, cid, anchors, reads };
}

const run = async (w: World, c: NotarizationConfig = cfg) => verifyNotarization(w.cid, w.reads, c);
const outcome = async (w: World, c?: NotarizationConfig) => { const r = await run(w, c); return r.valid ? "valid" : r.code; };

describe("algorithm N (notary_lifecycle.md A.4) with real simulator attestations", () => {
  it("accepts a good notarization: no warnings, output and counts returned", async () => {
    const r = await run(world());
    expect(r).toMatchObject({ valid: true, accepted: 42, rejected: 4, final_epoch: 0, suppressed: false, output: { abstain: 3, no: 12, yes: 27 }, warnings: [] });
    if (r.valid) expect(r.chain_state_age_seconds).toBe(3597);
  });

  // N1
  it("N1 NOT_MALFORMED: unknown cid, job_hash mismatch, extra field", async () => {
    expect(await verifyNotarization("bafkreiaaaa", world().reads, cfg)).toMatchObject({ valid: false, code: "NOT_MALFORMED" });
    expect(await outcome(world({ patch: (n) => { n["job_hash"] = b64uEncode(new Uint8Array(32)); } }))).toBe("NOT_MALFORMED");
    expect(await outcome(world({ patch: (n) => { n["extra"] = 1; } }))).toBe("NOT_MALFORMED");
  });
  // N2
  it("N2 NOT_SIGNATURE_INVALID: signature by a stranger, or notary_card is not the signer", async () => {
    expect(await outcome(world({ patch: (n) => { n["notary_card"] = cardPointer(key(9).publicKey); } }))).toBe("NOT_SIGNATURE_INVALID");
  });
  // N3, N4, N4a
  it("N3 NOT_NOTARY_NOT_APPROVED", async () => {
    expect(await outcome(world({ policy: { approvedNotaries: [] } }))).toBe("NOT_NOTARY_NOT_APPROVED");
    expect(await outcome(world({ policy: { chainValid: false } }))).toBe("NOT_NOTARY_NOT_APPROVED");
  });
  it("N4 NOT_NOTARY_REVOKED at or before closed_at; revocation after closed_at is fine", async () => {
    expect(await outcome(world({ reads: { notaryCard: async () => ({ recipientPubkey: pub(1), chainValid: true, revokedAtMs: T(CLOSED_AT) }) } }))).toBe("NOT_NOTARY_REVOKED");
    expect(await outcome(world({ reads: { notaryCard: async () => ({ recipientPubkey: pub(1), chainValid: true, revokedAtMs: T(CLOSED_AT) + 1 }) } }))).toBe("valid");
  });
  it("N4a key exposure: rejected, warned (later), lineage; judged at the anchor time of the notarized record", async () => {
    expect(await outcome(world({ reads: { keyExposure: async () => "exposed" } }))).toBe("NOT_NOTARY_KEY_EXPOSED");
    expect(await outcome(world({ reads: { keyExposure: async () => "lineage_incomplete" } }))).toBe("NOTARY_LINEAGE_INCOMPLETE");
    const r = await run(world({ reads: { keyExposure: async () => "later" } }));
    expect(r).toMatchObject({ valid: true }); if (r.valid) expect(r.warnings).toContain("notary_key_exposed_later");
    let seen = 0;
    await run(world({ reads: { keyExposure: async (_c, t) => { seen = t; return "none"; } } }));
    expect(seen).toBe(T("2026-11-19T10:05:00Z")); // the anchor time of the notarized record, not a notary-signed field
  });
  // N5
  it("N5 NOT_POLICY_MISMATCH", async () => {
    expect(await outcome(world({ policy: { notary: { ...notary, program_cid: "bafkreiother" } } }))).toBe("NOT_POLICY_MISMATCH");
    expect(await outcome(world({ policy: { notary: { ...notary, platform: "aws-nitro-enclaves" } } }))).toBe("NOT_POLICY_MISMATCH");
  });
  // N6
  it("N6 closing attestation: wrong program, debug, wrong nonce, wrong epoch, unknown runtime", async () => {
    expect(await outcome(world({ closerDoc: "closer_wrong_program" }))).toBe("ATT_BINDING_MISMATCH");
    expect(await outcome(world({ closerDoc: "closer_debug" }))).toBe("ATT_DEBUG_MODE");
    expect(await outcome(world({ closerDoc: "closer_wrong_nonce" }))).toBe("ATT_NONCE_MISMATCH");
    expect(await outcome(world({ closerDoc: "closer_wrong_epoch" }))).toBe("ATT_BINDING_MISMATCH");
    expect(await outcome(world({ closerDoc: "closer_other_pcr0" }))).toBe("ATT_RUNTIME_NOT_ACCEPTED");
    expect(await outcome(world(), { ...cfg, attest: { ...cfg.attest, allowSimulator: false } })).toBe("ATT_PLATFORM_NOT_ALLOWED");
  });
  it("N6 warns when the runtime was retired as vulnerable after the evaluation time", async () => {
    const r = await run(world(), { ...cfg, acceptedRuntimes: accepted.map((a) => ({ ...a, retired_at: "2027-01-01T00:00:00Z", retire_reason: "vulnerable" as const })) });
    expect(r.valid).toBe(true); if (r.valid) expect(r.warnings).toContain("runtime_retired_vulnerable");
  });
  // N7
  it("N7 NOT_CHAIN_MISMATCH: unknown block, wrong hash, closed_at before closes_at", async () => {
    expect(await outcome(world({ reads: { block: async () => null } }))).toBe("NOT_CHAIN_MISMATCH");
    expect(await outcome(world({ reads: { block: async () => ({ hash: "AAAA", timestampMs: T(CLOSED_AT) }) } }))).toBe("NOT_CHAIN_MISMATCH");
    expect(await outcome(world({ patch: (n) => { n["closed_at"] = "2026-11-19T09:59:00Z"; n["chain_state"].block_timestamp = "2026-11-19T09:59:00Z"; },
      reads: { block: async (_n) => ({ hash: b64uEncode(sha256(te.encode("blk"))), timestampMs: T("2026-11-19T09:59:00Z") }) } }))).toBe("NOT_CHAIN_MISMATCH");
  });
  // N8
  it("N8 NOT_COMMITMENT_MISMATCH: wrong root, wrong count, unsorted or duplicated list, missing list", async () => {
    expect(await outcome(world({ patch: (n) => { n["input_commitment"] = b64uEncode(new Uint8Array(32)); } }))).toBe("NOT_COMMITMENT_MISMATCH");
    expect(await outcome(world({ patch: (n) => { n["accepted"] = 41; } }))).toBe("NOT_COMMITMENT_MISMATCH");
    expect(await outcome(world({ patch: (n) => { n["counted_inputs"] = put(canonicalNotary([...counted].reverse().map(b64uEncode))); } }))).toBe("NOT_COMMITMENT_MISMATCH");
    expect(await outcome(world({ patch: (n) => { n["counted_inputs"] = put(canonicalNotary([counted[0], ...counted.slice(0, 41)].map((x) => b64uEncode(x!)))); } }))).toBe("NOT_COMMITMENT_MISMATCH");
    expect(await outcome(world({ patch: (n) => { n["counted_inputs"] = "bafkreiaaaa"; } }))).toBe("NOT_COMMITMENT_MISMATCH");
  });
  // N9, N10
  it("N9 NOT_SUPPRESSION_INVALID: below k_min but not suppressed, or suppressed with a real output", async () => {
    const few = counted.slice(0, 3), fc = put(canonicalNotary(few.map(b64uEncode)));
    expect(await outcome(world({ patch: (n) => { n["accepted"] = 3; n["counted_inputs"] = fc; n["input_commitment"] = b64uEncode(inputCommitment(few)); } }))).toBe("NOT_SUPPRESSION_INVALID");
    expect(await outcome(world({ patch: (n) => { n["suppressed"] = true; } }))).toBe("NOT_SUPPRESSION_INVALID");
  });
  it("N9/N10 a correctly suppressed notarization is valid", async () => {
    const few = counted.slice(0, 3), fc = put(canonicalNotary(few.map(b64uEncode)));
    const r = await run(world({ patch: (n) => { n["accepted"] = 3; n["counted_inputs"] = fc; n["input_commitment"] = b64uEncode(inputCommitment(few)); n["suppressed"] = true;
      n["output"] = { public: { insufficient_participation: true } }; n["output_hash"] = H({ insufficient_participation: true }); } }));
    expect(r).toMatchObject({ valid: true, suppressed: true });
  });
  it("N10 NOT_OUTPUT_INVALID: out-of-range value, unknown field, hash mismatch", async () => {
    expect(await outcome(world({ patch: (n) => { n["output"] = { public: { abstain: 3, no: 12, yes: 2000 } }; n["output_hash"] = H({ abstain: 3, no: 12, yes: 2000 }); } }))).toBe("NOT_OUTPUT_INVALID");
    expect(await outcome(world({ patch: (n) => { n["output"] = { public: { abstain: 3, no: 12, yes: 27, extra: 1 } }; n["output_hash"] = H({ abstain: 3, no: 12, yes: 27, extra: 1 }); } }))).toBe("NOT_OUTPUT_INVALID");
    expect(await outcome(world({ patch: (n) => { n["output_hash"] = b64uEncode(new Uint8Array(32)); } }))).toBe("NOT_OUTPUT_INVALID");
  });
  it("publicOutputValid applies clamp, round_to, buckets, suppress_cell_below_k, required, enum", () => {
    expect(publicOutputValid({ a: 10 }, [{ name: "a", type: "integer", round_to: 5 }])).toBe(true);
    expect(publicOutputValid({ a: 11 }, [{ name: "a", type: "integer", round_to: 5 }])).toBe(false);
    expect(publicOutputValid({ a: 3 }, [{ name: "a", type: "integer", buckets: [0, 5, 10], clamp: [0, 10] }])).toBe(false);
    expect(publicOutputValid({ a: 1 }, [{ name: "a", type: "integer", required: false, suppress_cell_below_k: 3 }])).toBe(false);
    expect(publicOutputValid({}, [{ name: "a", type: "integer", required: false, suppress_cell_below_k: 3 }])).toBe(true);
    expect(publicOutputValid({}, [{ name: "a", type: "integer" }])).toBe(false);
    expect(publicOutputValid({ t: "x" }, [{ name: "t", type: "text", enum: ["x", "y"] }])).toBe(true);
    expect(publicOutputValid({ t: "z" }, [{ name: "t", type: "text", enum: ["x", "y"] }])).toBe(false);
    expect(publicOutputValid({ t: "x" }, [{ name: "t", type: "text" }])).toBe(false);
  });
  // N11
  it("N11 warnings: a missing log record, a forked anchor, a total_loss epoch", async () => {
    const gap = await run(world({ dropRecord: true }));
    expect(gap).toMatchObject({ valid: true }); if (gap.valid) expect(gap.warnings).toContain("JOB_LOG_GAP");
    const fork = await run(world({ extraAnchors: () => [{ seq: 0, record_cid: "bafkreiother", timestamp: T("2026-11-12T10:00:11Z") }] }));
    if (fork.valid) expect(fork.warnings).toContain("JOB_LOG_FORK"); else throw new Error("expected valid");
    const loss = await run(world({ totalLoss: true }));
    if (loss.valid) expect(loss.warnings).toContain("EPOCH_TOTAL_LOSS"); else throw new Error(`expected valid, got ${loss.code}`);
  });
  // N12
  it("N12 NOT_QUORUM_INSUFFICIENT: one cosignature, a wrong-instance attestation, a duplicate instance, a signature over the base64url text, bad close_quorum", async () => {
    expect(await outcome(world({ cosigs: ["closer"] }))).toBe("NOT_QUORUM_INSUFFICIENT");
    expect(await outcome(world({ cosigs: ["closer", "cosig_1_wrong_instance"] }))).toBe("NOT_QUORUM_INSUFFICIENT");
    expect(await outcome(world({ cosigs: ["closer", "closer"] }))).toBe("NOT_QUORUM_INSUFFICIENT");
    expect(await outcome(world({ cosigs: ["closer", "cosig_1_stranger_id"] }))).toBe("NOT_QUORUM_INSUFFICIENT");
    expect(await outcome(world({ cosigDigestOverText: true }))).toBe("NOT_QUORUM_INSUFFICIENT");
    expect(await outcome(world({ patch: (n) => { n["close_quorum"] = 1; } }))).toBe("NOT_QUORUM_INSUFFICIENT");
    expect(await outcome(world({ cosigs: ["closer", "cosig_1"] }))).toBe("valid"); // exactly q = 2
  });
  // N13
  it("N13 NOT_EPOCH_SUPERSEDED: a higher epoch anchored before closed_at; after closed_at is fine", async () => {
    const early = (log: { cid: string }[]) => { void log; const r = logRecord(3, "epoch_started", { epoch: 1, epoch_reason: "key_period" }); return [{ seq: 3, record_cid: r.cid, timestamp: T("2026-11-19T10:00:02Z") }]; };
    expect(await outcome(world({ extraAnchors: early }))).toBe("NOT_EPOCH_SUPERSEDED");
    const late = (log: { cid: string }[]) => { void log; const r = logRecord(3, "epoch_started", { epoch: 1, epoch_reason: "key_period" }); return [{ seq: 3, record_cid: r.cid, timestamp: T("2026-11-19T10:00:04Z") }]; };
    expect(await outcome(world({ extraAnchors: late }))).toBe("valid");
  });
  it("order: signature problems are reported before attestation problems", async () => {
    expect(await outcome(world({ closerDoc: "closer_debug", policy: { approvedNotaries: [] } }))).toBe("NOT_NOTARY_NOT_APPROVED");
  });
  it("withoutFields helper is what the signing form uses", () => { expect(Object.keys(withoutFields({ a: 1, b: 2 }, "b"))).toEqual(["a"]); });
});
