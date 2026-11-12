/**
 * Algorithm W: the wallet's check of a job announcement before encrypting anything
 * (notary_lifecycle.md Appendix A.2; wallet_sdk.md §7b.2). Steps W1–W15, in order, one reject code each.
 *
 * The wallet uses its **own** chain and card reads, never data from the notary host: they come in through
 * `NotaryChainReads` (production wiring over `CardVerifier` is Phase 7; tests use mocks for the card reads
 * and **real simulator attestation documents** for W13). The governance lists must already have passed
 * algorithm L (A.5); algorithm L itself lands once erratum E6 is decided.
 */
import {
  assertNotaryObject, b64uDecode, b64uEncode, canonicalNotary, cardPointer, cidOfBytes, digestFromCid, encodeUserData, H, hBytes,
  parseTimestamp, verifyAttestation, withoutFields,
} from "@membership-card-protocol/verifier/notary";
import type { AcceptedRuntime, AllowlistedProgram, AttestationVerifier, CardPredicate, NotarySection } from "@membership-card-protocol/verifier/notary";
import { mlDsa44Verify } from "@membership-card-protocol/verifier";
import { sha256 } from "@noble/hashes/sha256";
import type { NotaryConfig } from "./config.js";
import { DEFAULT_MAX_ATTESTATION_AGE_SECONDS } from "./config.js";
import { buildConsent } from "./consent.js";
import type { NotaryConsent } from "./consent.js";
import { parametersWithinBounds } from "./parameters.js";
import type { JobAnnouncement } from "./types.js";

export interface PolicyRead {
  headCid: string;
  /** Every state CID of the policy, including the head. */
  stateCids: string[];
  notary: NotarySection;
  approvedNotaries: string[];
}

export interface NotaryCardRead {
  policy_id: string;
  issuer_card: string;
  platform: string;
  revoked: boolean;
  /** K_id (ML-DSA-44), base64url: the notary card's `recipient_pubkey`. */
  recipient_pubkey: string;
  operator_card: string;
}

/** The wallet's own chain and card reads (wrapping `CardVerifier`; never the notary host). */
export interface NotaryChainReads {
  nowMs(): number;
  /** `null`: the policy chain does not reach a trusted root (W3). */
  policy(policyId: string): Promise<PolicyRead | null>;
  /** The policy's `notary` section and `approved_notaries` as of a past state, or `null` if not in its history. */
  policyAtState(policyId: string, stateCid: string): Promise<{ notary: NotarySection; approvedNotaries: string[] } | null>;
  satisfies(predicate: CardPredicate, card: string): Promise<boolean>;
  notaryCard(pointer: string): Promise<NotaryCardRead | null>;
  /** Algorithm E (A.6) at `t = now`. */
  keyExposed(pointer: string, atMs: number): Promise<boolean>;
  fetchAttestation(cid: string): Promise<Uint8Array>;
}

export interface VerifiedLists {
  acceptedRuntimes: AcceptedRuntime[];
  programAllowlist: AllowlistedProgram[];
}

export interface VerifyJobOptions {
  announcement: unknown;
  config: NotaryConfig;
  reads: NotaryChainReads;
  lists: VerifiedLists;
  attestation: AttestationVerifier[];
  /** Highest epoch the wallet has stored for this job (W12). */
  highestEpochSeen?: number;
  /** Platform name of the notary cards' `notary.platform`; read from the policy. */
}

export type VerifyJobResult =
  | { valid: true; jobHash: string; epoch: number; consent: NotaryConsent; warnings: string[] }
  | { valid: false; code: string; reason: string };

const bad = (code: string, reason: string): VerifyJobResult => ({ valid: false, code, reason });
const hexToBytes = (h: string) => Uint8Array.from(h.match(/../g)!.map((x) => parseInt(x, 16)));

export async function verifyNotaryJob(o: VerifyJobOptions): Promise<VerifyJobResult> {
  const { config, reads, lists } = o;
  const now = reads.nowMs();
  // W1
  try { assertNotaryObject(o.announcement, "notary.announcement.v1"); } catch (e) { return bad("ANN_MALFORMED", String((e as Error).message)); }
  const ann = o.announcement as unknown as JobAnnouncement;
  try { assertNotaryObject(ann.job, "notary.job.v1"); } catch (e) { return bad("ANN_MALFORMED", `job: ${(e as Error).message}`); }
  const job = ann.job;
  // W2
  let jobHash: string;
  try {
    const pk = b64uDecode(job.requester_pubkey, 1312);
    if (cardPointer(pk) !== job.requester_card) return bad("JOB_SIGNATURE_INVALID", "requester_pubkey does not hash to requester_card");
    if (job.requester_signature.public_key !== job.requester_pubkey) return bad("JOB_SIGNATURE_INVALID", "signature key is not the requester key");
    const msg = canonicalNotary(withoutFields(job as unknown as Record<string, unknown>, "requester_signature"));
    if (!mlDsa44Verify(pk, msg, b64uDecode(job.requester_signature.signature, 2420))) return bad("JOB_SIGNATURE_INVALID", "requester signature does not verify");
    jobHash = H(job);
  } catch (e) { return bad("JOB_SIGNATURE_INVALID", String((e as Error).message)); }
  // W3
  const policy = await reads.policy(job.policy_id);
  if (!policy) return bad("JOB_POLICY_UNTRUSTED", "policy chain does not reach a trusted root");
  // W4
  if (job.policy_state_cid !== policy.headCid) {
    const past = policy.stateCids.includes(job.policy_state_cid) ? await reads.policyAtState(job.policy_id, job.policy_state_cid) : null;
    if (!past || H(past.notary) !== H(policy.notary) || H(past.approvedNotaries) !== H(policy.approvedNotaries))
      return bad("JOB_POLICY_CHANGED", "notary section or approved_notaries changed since the job was signed");
  }
  const notary = policy.notary;
  // W5
  if (notary.job_requester_predicate && !(await reads.satisfies(notary.job_requester_predicate, job.requester_card)))
    return bad("JOB_REQUESTER_NOT_PERMITTED", "requester does not satisfy job_requester_predicate");
  // W6
  if (!parametersWithinBounds(job.parameters, notary.parameter_bounds)) return bad("JOB_PARAMETERS_OUT_OF_BOUNDS", "parameters outside parameter_bounds");
  // W7
  const n = job.replica_set.reduce((a, r) => a + r.instances, 0);
  const q = Math.floor(n / 2) + 1;
  const malformed = (r: string) => bad("JOB_MALFORMED", r);
  if (job.replica_set.length === 0 || job.replica_set.some((r) => !Number.isInteger(r.instances) || r.instances < 1)) return malformed("replica_set");
  if (!(q <= job.min_live && job.min_live <= n)) return malformed("min_live must satisfy q <= min_live <= N");
  try {
    const opens = parseTimestamp(job.opens_at);
    if (notary.mode === "aggregate") {
      if (!job.closes_at || job.ends_at || job.key_period) return malformed("aggregate job needs closes_at only");
      if (parseTimestamp(job.closes_at) <= opens) return malformed("closes_at must be after opens_at");
    } else {
      if (!job.ends_at || !job.key_period || job.closes_at) return malformed("per_input job needs ends_at and key_period");
      if (parseTimestamp(job.ends_at) > opens + 366 * 86_400_000) return malformed("ends_at is more than a year after opens_at");
    }
    // W8
    if (now >= parseTimestamp((job.closes_at ?? job.ends_at)!)) return bad("JOB_CLOSED", "the job has closed");
  } catch (e) { return malformed(String((e as Error).message)); }
  // W9
  if (!config.acceptedKems.includes(job.kem) || ann.job.kem !== "x-wing-draft-06") return bad("JOB_KEM_UNSUPPORTED", job.kem);
  // W10
  const idKeys = new Map<string, string>(); // replica card -> K_id
  for (const r of job.replica_set) {
    const card = await reads.notaryCard(r.notary_card);
    if (!policy.approvedNotaries.includes(r.notary_card) || !card || card.revoked || card.policy_id !== config.notaryCardPolicy ||
        card.issuer_card !== job.policy_id || card.platform !== notary.platform)
      return bad("JOB_NOTARY_NOT_APPROVED", r.notary_card);
    // W10a
    if (await reads.keyExposed(r.notary_card, now)) return bad("JOB_NOTARY_KEY_EXPOSED", r.notary_card);
    idKeys.set(r.notary_card, card.recipient_pubkey);
  }
  // W11
  const signerCard = cardPointer((() => { try { return b64uDecode(ann.notary_signature.public_key, 1312); } catch { return new Uint8Array(0); } })());
  const kId = idKeys.get(signerCard);
  try {
    if (!kId || kId !== ann.notary_signature.public_key ||
        !mlDsa44Verify(b64uDecode(kId, 1312), canonicalNotary(withoutFields(ann as unknown as Record<string, unknown>, "notary_signature")), b64uDecode(ann.notary_signature.signature, 2420)))
      return bad("ANN_SIGNATURE_INVALID", "announcement not signed by a replica_set notary card");
  } catch { return bad("ANN_SIGNATURE_INVALID", "announcement signature malformed"); }
  // W12
  if (ann.epoch > 0 ? !ann.prev_announcement || !ann.epoch_reason : ann.prev_announcement !== undefined || ann.epoch_reason !== undefined)
    return bad("ANN_EPOCH_REGRESSION", "epoch chain is inconsistent");
  if (o.highestEpochSeen !== undefined && ann.epoch < o.highestEpochSeen) return bad("ANN_EPOCH_REGRESSION", `epoch ${ann.epoch} is below ${o.highestEpochSeen}`);
  // W13
  let programHash: Uint8Array;
  try { programHash = digestFromCid(notary.program_cid); } catch { return bad("ATT_BINDING_MISMATCH", "program_cid is not a raw sha2-256 CIDv1"); }
  let jobPk: Uint8Array;
  try { jobPk = b64uDecode(ann.job_public_key, 1216); } catch { return bad("ATT_KEY_MISMATCH", "job_public_key is not 1216 bytes"); }
  if (ann.attestations.length === 0) return bad("ATT_MALFORMED", "no attestations");
  const isolation = notary.isolation === "shared" ? 0x01 : 0x02;
  const maxAgeMs = (config.maxAttestationAgeSeconds ?? DEFAULT_MAX_ATTESTATION_AGE_SECONDS) * 1000;
  const roots: Record<string, Uint8Array> = { "aws-nitro-enclaves": config.attestationRoots["aws-nitro-enclaves"] };
  if (config.attestationRoots.simulator) roots["simulator"] = config.attestationRoots.simulator;
  let firstFailure: string | undefined;
  let passed: { warnings: string[] } | undefined;
  for (const cid of ann.attestations) {
    for (const [replica, key] of idKeys) {
      void replica;
      const bytes = await reads.fetchAttestation(cid);
      if (b64uEncode(digestFromCid(cid)) !== b64uEncode(sha256(bytes))) { firstFailure ??= "ATT_MALFORMED"; continue; }
      const idHash = hexToBytes(cardPointer(b64uDecode(key, 1312)));
      const userData = encodeUserData({ purpose: 0x02, idKeyHash: idHash, programHash, jobHash: hBytes(job), epoch: BigInt(ann.epoch), isolation: isolation as 1 | 2 });
      const r = verifyAttestation(bytes, { roots, allowSimulator: config.allowSimulator }, o.attestation,
        { userData, anyInstanceKey: true, nonce: hBytes(job), publicKey: sha256(jobPk) },
        { tEvalMs: now, nowMs: now, maxAgeMs, acceptedRuntimes: lists.acceptedRuntimes, platform: notary.platform });
      if (r.ok) { passed = { warnings: r.warnings }; break; }
      firstFailure ??= r.code;
    }
    if (passed) break;
  }
  if (!passed) return bad(firstFailure ?? "ATT_MALFORMED", "no attestation verified");
  // W14
  const allow = lists.programAllowlist.find((p) => p.program_cid === notary.program_cid && parseTimestamp(p.accepted_from) <= now && (p.retired_at === undefined || now < parseTimestamp(p.retired_at)));
  if (notary.isolation === "shared" && !allow) return bad("JOB_PROGRAM_NOT_ALLOWLISTED", notary.program_cid);
  // W15
  if (passed.warnings.includes("runtime_retired_vulnerable")) return bad("ATT_RUNTIME_NOT_ACCEPTED", "runtime retired as vulnerable");
  void cidOfBytes; void b64uEncode;
  return { valid: true, jobHash, epoch: ann.epoch, consent: buildConsent({ job, notary, allowlisted: allow, notaries: [...idKeys.keys()].map((c) => ({ notaryCard: c })) as never, operatorCards: await operatorCards(reads, [...idKeys.keys()]), platform: notary.platform }), warnings: passed.warnings };
}

async function operatorCards(reads: NotaryChainReads, cards: string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const c of cards) out[c] = (await reads.notaryCard(c))?.operator_card ?? "";
  return out;
}
