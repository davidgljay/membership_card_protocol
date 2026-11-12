/**
 * Algorithm N: notarization verification (notary_lifecycle.md Appendix A.4; card_verifier.md §6.5).
 *
 * Uses CIDs and chain data only. All reads come in through `NotarizationReads`, which the
 * `CardVerifier`-backed adapter (Phase 7) and tests implement; nothing is read from the notary host.
 * The governance lists must already have passed algorithm L.
 *
 * Decisions: E6 (cosignatures sign the 32 raw bytes of H(body)), E13 (the final-epoch job key is unknown to a
 * verifier, so attestation `public_key` is required to be present but is not compared; `inst_key_hash` is
 * compared for cosigners, whose instance key is in the cosignature), E14 (`counted_inputs` is a canonical JSON
 * array of base64url input hashes pinned as a raw CID).
 *
 * Job-log note: a log record whose signatures do not verify ends the walk and is reported as `JOB_LOG_GAP`
 * (the spec makes N11 findings warnings, not rejections).
 */
import { sha256 } from "@noble/hashes/sha256";
import { ml_dsa44 } from "@noble/post-quantum/ml-dsa.js";
import {
  b64uDecode, b64uEncode, canonicalNotary, cardPointer, digestFromCid, encodeUserData, H, hBytes,
  inputCommitment, parseCanonicalNotary, parseTimestamp, withoutFields, NotaryFormatError,
} from "./canonical.js";
import { assertNotaryObject } from "./types.js";
import { verifyAttestation } from "./attest.js";
import type { AttestConfig, VerifyContext } from "./attest.js";
import type { AcceptedRuntime, AttestationVerifier, FieldDefinition, NotarySection, Notarization, JobLogRecord } from "./types.js";

export interface NotarizationReads {
  nowMs(): number;
  /** IPFS bytes for a CID, or null. The caller of `fetch` need not verify the digest: N does. */
  fetch(cid: string): Promise<Uint8Array | null>;
  /** The policy's `notary` section and `approved_notaries` at a state, and whether its chain reaches a trusted root. */
  policyAt(policyId: string, stateCid: string): Promise<{ notary: NotarySection; approvedNotaries: string[]; chainValid: boolean } | null>;
  /** The notary card: its K_id, chain validity, and the earliest 8xx/9xx revocation's effective time (ms), if any. */
  notaryCard(pointer: string): Promise<{ recipientPubkey: string; chainValid: boolean; revokedAtMs?: number } | null>;
  /** A block on the verifier's own chain view. */
  block(number: number): Promise<{ hash: string; timestampMs: number } | null>;
  /** Algorithm E (A.6) for a notary card at chain time `tMs`. */
  keyExposure(pointer: string, tMs: number): Promise<"none" | "exposed" | "later" | "lineage_incomplete">;
  /** EAS anchors under the notary schema for a scope (`getNotaryLogAnchors`). */
  anchors(scopeId: string): Promise<{ seq: number; record_cid: string; timestamp: number }[]>;
}

export interface NotarizationConfig {
  attest: AttestConfig;
  modules: AttestationVerifier[];
  acceptedRuntimes: AcceptedRuntime[];
}

export type NotarizationWarning = "runtime_retired_vulnerable" | "notary_key_exposed_later" | "JOB_LOG_GAP" | "JOB_LOG_FORK" | "EPOCH_TOTAL_LOSS";

export type NotarizationVerificationResult =
  | { valid: true; job_hash: string; notary_card: string; final_epoch: number; accepted: number; rejected: number; dropped_after_acceptance: number;
      suppressed: boolean; output?: unknown; output_hash: string; chain_state_age_seconds: number; warnings: NotarizationWarning[] }
  | { valid: false; code: string; reason: string };

const fail = (code: string, reason: string): NotarizationVerificationResult => ({ valid: false, code, reason });
const hexBytes = (h: string) => Uint8Array.from(h.match(/../g)!.map((x) => parseInt(x, 16)));

async function fetchChecked(reads: NotarizationReads, cid: string): Promise<Uint8Array | null> {
  const bytes = await reads.fetch(cid);
  if (!bytes) return null;
  try { return b64uEncode(digestFromCid(cid)) === b64uEncode(sha256(bytes)) ? bytes : null; } catch { return null; }
}

const verifySig = (pub: string, msg: Uint8Array, sig: string) => {
  try { return ml_dsa44.verify(b64uDecode(sig, 2420), msg, b64uDecode(pub, 1312)); } catch { return false; }
};

/** Validates a public output against `output_schema` and its privacy transforms (N10). */
export function publicOutputValid(value: unknown, schema: FieldDefinition[]): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const obj = value as Record<string, unknown>;
  const names = new Set(schema.map((f) => f["name"] as string));
  if (Object.keys(obj).some((k) => !names.has(k))) return false;
  for (const f of schema) {
    const name = f["name"] as string, v = obj[name];
    if (v === undefined) { if (f["required"] === false) continue; return false; }
    if (f["type"] === "boolean") { if (typeof v !== "boolean") return false; continue; }
    if (f["type"] === "text") { if (typeof v !== "string" || !Array.isArray(f["enum"]) || !(f["enum"] as string[]).includes(v) || v.length > 256) return false; continue; }
    if (f["type"] !== "integer" || typeof v !== "number" || !Number.isInteger(v)) return false;
    const clamp = f["clamp"] as [number, number] | undefined;
    if (clamp && (v < clamp[0] || v > clamp[1])) return false;
    if (typeof f["round_to"] === "number" && v % (f["round_to"] as number) !== 0) return false;
    if (Array.isArray(f["buckets"]) && !(f["buckets"] as number[]).includes(v)) return false;
    if (typeof f["suppress_cell_below_k"] === "number" && v > 0 && v < (f["suppress_cell_below_k"] as number)) return false;
  }
  return true;
}

export async function verifyNotarization(notarizationCid: string, reads: NotarizationReads, cfg: NotarizationConfig): Promise<NotarizationVerificationResult> {
  const warnings: NotarizationWarning[] = [];
  const addWarning = (w: NotarizationWarning) => { if (!warnings.includes(w)) warnings.push(w); };
  // ---- N1 ----
  const nBytes = await fetchChecked(reads, notarizationCid);
  if (!nBytes) return fail("NOT_MALFORMED", "notarization not found or does not match its CID");
  let n: Notarization;
  try {
    const obj = parseCanonicalNotary(nBytes);
    assertNotaryObject(obj, "notary.notarization.v1");
    n = obj as unknown as Notarization;
  } catch (e) { return fail("NOT_MALFORMED", String((e as Error).message)); }
  const jobBytes = await fetchChecked(reads, n.job_cid);
  if (!jobBytes) return fail("NOT_MALFORMED", "job not found or does not match job_cid");
  let job: Record<string, any>;
  try {
    const jobObj = parseCanonicalNotary(jobBytes);
    assertNotaryObject(jobObj, "notary.job.v1");
    job = jobObj as Record<string, any>;
    if (H(job) !== n.job_hash) return fail("NOT_MALFORMED", "job_hash does not match the job");
    const rp = b64uDecode(job["requester_pubkey"], 1312);
    if (cardPointer(rp) !== job["requester_card"] || job["requester_signature"].public_key !== job["requester_pubkey"] ||
        !verifySig(job["requester_pubkey"], canonicalNotary(withoutFields(job, "requester_signature")), job["requester_signature"].signature))
      return fail("NOT_MALFORMED", "job signature invalid");
  } catch (e) { return fail("NOT_MALFORMED", String((e as Error).message)); }
  // ---- N2 ----
  const sigMsg = canonicalNotary(withoutFields(n as unknown as Record<string, unknown>, "notary_signature"));
  let signerOk = false;
  try { signerOk = cardPointer(b64uDecode(n.notary_signature.public_key, 1312)) === n.notary_card && verifySig(n.notary_signature.public_key, sigMsg, n.notary_signature.signature); } catch { /* invalid */ }
  if (!signerOk) return fail("NOT_SIGNATURE_INVALID", "notary_signature does not verify for notary_card");
  // ---- N3 ----
  const policy = await reads.policyAt(n.policy_id, n.policy_state_cid);
  const card = await reads.notaryCard(n.notary_card);
  const replicaCards: string[] = (job["replica_set"] as { notary_card: string; instances: number }[]).map((r) => r.notary_card);
  if (!policy || !card || !policy.chainValid || !card.chainValid || !replicaCards.includes(n.notary_card) || !policy.approvedNotaries.includes(n.notary_card))
    return fail("NOT_NOTARY_NOT_APPROVED", "notary card is not in replica_set and approved_notaries at policy_state_cid with a valid chain");
  const closedAt = parseTimestamp(n.closed_at);
  // ---- N4 ----
  if (card.revokedAtMs !== undefined && card.revokedAtMs <= closedAt) return fail("NOT_NOTARY_REVOKED", "notary card revoked at or before closed_at");
  // job log walk (needed for N4a's anchor time, N11, N13)
  const anchors = await reads.anchors(n.job_hash);
  const records = new Map<string, JobLogRecord>();
  const walk: JobLogRecord[] = [];
  {
    let cid: string | undefined = n.job_log_head;
    let expectSeq: number | undefined;
    while (cid) {
      const rb = await fetchChecked(reads, cid);
      if (!rb) { addWarning("JOB_LOG_GAP"); break; }
      let rec: JobLogRecord;
      try {
        const obj = parseCanonicalNotary(rb);
        assertNotaryObject(obj, "notary.job_log.v1");
        rec = obj as unknown as JobLogRecord;
      } catch { addWarning("JOB_LOG_GAP"); break; }
      const unsigned = canonicalNotary(withoutFields(rec as unknown as Record<string, unknown>, "notary_signature", "instance_signature"));
      let ok = rec.job_hash === n.job_hash && (expectSeq === undefined || rec.seq === expectSeq);
      try {
        const kinst = b64uDecode(rec.instance_signature.public_key, 1312);
        ok = ok && rec.instance === b64uEncode(sha256(kinst)) && verifySig(rec.instance_signature.public_key, unsigned, rec.instance_signature.signature) &&
          replicaCards.includes(cardPointer(b64uDecode(rec.notary_signature.public_key, 1312))) && verifySig(rec.notary_signature.public_key, unsigned, rec.notary_signature.signature);
      } catch { ok = false; }
      if (!ok) { addWarning("JOB_LOG_GAP"); break; }
      walk.push(rec); records.set(cid, rec);
      if (rec.kind === "epoch_started" && (rec.body as { epoch_reason?: string })["epoch_reason"] === "total_loss") addWarning("EPOCH_TOTAL_LOSS");
      if (rec.seq === 0) break;
      expectSeq = rec.seq - 1;
      cid = rec.prev;
      if (!cid) { addWarning("JOB_LOG_GAP"); break; }
    }
    if (walk.length > 0 && walk[walk.length - 1]!.seq !== 0) addWarning("JOB_LOG_GAP");
    const ANCHORED = ["opened", "epoch_started", "handoff", "replica_lost", "notarized", "issued", "aborted"];
    for (const r of walk) {
      if (!ANCHORED.includes(r.kind)) continue;
      const cidOf = [...records.entries()].find(([, v]) => v === r)![0];
      const a = anchors.filter((x) => x.seq === r.seq);
      if (a.length === 0 || !a.some((x) => x.record_cid === cidOf)) addWarning("JOB_LOG_GAP");
    }
    const seqs = new Map<number, Set<string>>();
    for (const a of anchors) { const s = seqs.get(a.seq) ?? new Set(); s.add(a.record_cid); seqs.set(a.seq, s); }
    if ([...seqs.values()].some((s) => s.size > 1)) addWarning("JOB_LOG_FORK");
  }
  // anchored records (cached): the `notarized` record's anchor time is the chain time N4a judges the keys at
  const anchored: { a: { seq: number; record_cid: string; timestamp: number }; rec: JobLogRecord | null }[] = [];
  for (const a of anchors) {
    const rb = await fetchChecked(reads, a.record_cid);
    let rec: JobLogRecord | null = null;
    try { if (rb) rec = parseCanonicalNotary(rb) as unknown as JobLogRecord; } catch { rec = null; }
    anchored.push({ a, rec });
  }
  // ---- N4a ----
  const anchorT = anchored.find((x) => x.rec?.kind === "notarized" && (x.rec.body as { notarization?: string })["notarization"] === notarizationCid)?.a.timestamp ?? closedAt;
  const exposure = async (c: string): Promise<NotarizationVerificationResult | undefined> => {
    const st = await reads.keyExposure(c, anchorT);
    if (st === "exposed") return fail("NOT_NOTARY_KEY_EXPOSED", "notary key lived in a runtime retired as vulnerable before the notarization was anchored");
    if (st === "lineage_incomplete") return fail("NOTARY_LINEAGE_INCOMPLETE", "identity log has a gap or fork");
    if (st === "later") addWarning("notary_key_exposed_later");
    return undefined;
  };
  { const e = await exposure(n.notary_card); if (e) return e; }
  // ---- N5 ----
  if (n.program_cid !== policy.notary.program_cid || n.platform !== policy.notary.platform || n.policy_id !== job["policy_id"] || n.policy_state_cid !== job["policy_state_cid"])
    return fail("NOT_POLICY_MISMATCH", "program_cid or platform differ from the policy at policy_state_cid");
  // ---- N6 ----
  const aggregate = policy.notary.mode === "aggregate";
  const tEval = aggregate ? parseTimestamp(job["closes_at"]) : closedAt;
  const programHash = digestFromCid(n.program_cid);
  const isolation = policy.notary.isolation === "shared" ? 0x01 : 0x02;
  const jobHash = hBytes(job);
  const runAtt = async (attCid: string, idCard: string, inst: Uint8Array | undefined) => {
    const doc = await fetchChecked(reads, attCid);
    if (!doc) return { ok: false as const, code: "ATT_MALFORMED" };
    const userData = encodeUserData({ purpose: 0x02, idKeyHash: hexBytes(idCard), programHash, jobHash, epoch: BigInt(n.final_epoch), isolation: isolation as 1 | 2,
      ...(inst ? { instKeyHash: inst } : {}) });
    const ctx: VerifyContext = { tEvalMs: tEval, nowMs: reads.nowMs(), acceptedRuntimes: cfg.acceptedRuntimes, platform: n.platform };
    return verifyAttestation(doc, cfg.attest, cfg.modules, { userData, ...(inst ? {} : { anyInstanceKey: true }), anyPublicKey: true, nonce: jobHash }, ctx);
  };
  const closerAtt = await runAtt(n.attestation, n.notary_card, undefined);
  if (!closerAtt.ok) return fail(closerAtt.code, "closing replica attestation failed");
  if (closerAtt.warnings.includes("runtime_retired_vulnerable")) addWarning("runtime_retired_vulnerable");
  // ---- N7 ----
  const block = await reads.block(n.chain_state.block_number);
  const cs = n.chain_state;
  if (!block || block.hash !== cs.block_hash || block.timestampMs !== parseTimestamp(cs.block_timestamp) || closedAt !== block.timestampMs ||
      (aggregate && closedAt < parseTimestamp(job["closes_at"])))
    return fail("NOT_CHAIN_MISMATCH", "chain_state does not match the verifier's chain view, or closed_at precedes closes_at");
  // ---- N8 ----
  let counted: Uint8Array[] = [];
  try {
    const cb = await fetchChecked(reads, n.counted_inputs);
    if (!cb) throw new NotaryFormatError("X", "counted_inputs not found");
    const arr = parseCanonicalNotary(cb);
    if (!Array.isArray(arr) || arr.length !== n.accepted) throw new NotaryFormatError("X", "length");
    counted = arr.map((h) => b64uDecode(h as string, 32));
    if (b64uEncode(inputCommitment(counted)) !== n.input_commitment) throw new NotaryFormatError("X", "root");
  } catch { return fail("NOT_COMMITMENT_MISMATCH", "counted_inputs is missing, unsorted, duplicated, or does not give input_commitment"); }
  // ---- N9 ----
  const suppressedExpected = n.accepted < policy.notary.privacy.k_min;
  const outVal = (n.output as { public?: unknown }).public;
  if (n.suppressed !== suppressedExpected || (n.suppressed && outVal !== undefined && H(outVal) !== H({ insufficient_participation: true })))
    return fail("NOT_SUPPRESSION_INVALID", "suppressed does not equal accepted < k_min, or the suppressed output is not the fixed value");
  // ---- N10 ----
  if (outVal !== undefined) {
    const okOut = n.suppressed ? H(outVal) === H({ insufficient_participation: true }) : publicOutputValid(outVal, policy.notary.output_schema);
    if (!okOut || H(outVal) !== n.output_hash) return fail("NOT_OUTPUT_INVALID", "public output does not satisfy output_schema and its transforms, or output_hash differs");
  }
  // ---- N12 ----
  const N = (job["replica_set"] as { instances: number }[]).reduce((a, r) => a + r.instances, 0);
  const q = Math.floor(N / 2) + 1;
  const body = canonicalNotary(withoutFields(n as unknown as Record<string, unknown>, "cosignatures", "notary_signature"));
  const digest = sha256(body); // E6: cosignatures sign the 32 raw digest bytes
  const seen = new Set<string>();
  for (const c of n.cosignatures) {
    try {
      const kinst = b64uDecode(c.instance_signature.public_key, 1312);
      const instHash = sha256(kinst);
      const id = b64uEncode(instHash);
      if (seen.has(id) || !ml_dsa44.verify(b64uDecode(c.instance_signature.signature, 2420), digest, kinst)) continue;
      // the cosigner's replica card is any card in replica_set: try each until one binds
      let matched: string | undefined;
      for (const rc of replicaCards) { const rr = await runAtt(c.attestation, rc, instHash); if (rr.ok) { matched = rc; if (rr.warnings.includes("runtime_retired_vulnerable")) addWarning("runtime_retired_vulnerable"); break; } }
      if (matched === undefined) continue;
      if (matched !== n.notary_card) { const e = await exposure(matched); if (e) return e; }
      seen.add(id);
    } catch { /* invalid cosignature */ }
  }
  if (seen.size < q || n.close_quorum !== q) return fail("NOT_QUORUM_INSUFFICIENT", `${seen.size} valid cosignatures from distinct instances, need ${q}`);
  // ---- N13 ----
  for (const { a, rec } of anchored) {
    if (a.timestamp > closedAt || !rec) continue;
    if (rec.kind === "epoch_started" && typeof (rec.body as { epoch?: number })["epoch"] === "number" && (rec.body as { epoch: number }).epoch > n.final_epoch)
      return fail("NOT_EPOCH_SUPERSEDED", "a higher epoch was anchored before closed_at");
  }
  return {
    valid: true, job_hash: n.job_hash, notary_card: n.notary_card, final_epoch: n.final_epoch, accepted: n.accepted, rejected: n.rejected,
    dropped_after_acceptance: n.dropped_after_acceptance, suppressed: n.suppressed, ...(outVal !== undefined ? { output: outVal } : {}), output_hash: n.output_hash,
    chain_state_age_seconds: Math.max(0, Math.floor((reads.nowMs() - block.timestampMs) / 1000)), warnings,
  };
}
