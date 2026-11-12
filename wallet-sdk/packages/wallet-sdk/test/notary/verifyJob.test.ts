import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { sha256 } from "@noble/hashes/sha256";
import { ml_dsa44 } from "@noble/post-quantum/ml-dsa.js";
import { simulator, awsNitroEnclaves, awsNitroRootG1Der } from "@membership-card-protocol/notary-attestation";
import { b64uDecode, b64uEncode, canonicalNotary, cidOfBytes, withoutFields } from "@membership-card-protocol/verifier/notary";
import type { AcceptedRuntime, AllowlistedProgram, NotarySection } from "@membership-card-protocol/verifier/notary";
import { verifyNotaryJob } from "../../src/notary/verifyJob.js";
import type { NotaryChainReads, PolicyRead, VerifyJobOptions } from "../../src/notary/verifyJob.js";
import type { NotaryConfig } from "../../src/notary/config.js";
import { CUSTOM_PROGRAM_LABEL, PARTICIPATION_DISCLOSURE } from "../../src/notary/consent.js";
import type { JobAnnouncement, NotaryJob } from "../../src/notary/types.js";

const VEC = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "..", "notary", "vectors");
const load = (f: string) => JSON.parse(readFileSync(join(VEC, f), "utf8"));
const te = new TextEncoder();
const key = (n: number) => ml_dsa44.keygen(sha256(te.encode(`card-notary-vector-key-${n}`)));
const sign = (n: number, unsigned: object) => ({ public_key: b64uEncode(key(n).publicKey), signature: b64uEncode(ml_dsa44.sign(canonicalNotary(unsigned), key(n).secretKey, { extraEntropy: false })) });

const baseAnn = load("objects/announcement.json").cases[0].input as JobAnnouncement;
const fx = load("attestation/job_attestations.json");
const NOW = fx.now_ms as number;
const doc = (name: string) => b64uDecode(fx.docs[name]);
const K_ID = b64uEncode(key(1).publicKey);
const CARD1 = baseAnn.job.replica_set[0]!.notary_card;

const notarySection: NotarySection = {
  contributor_predicate: { issued_under_template: "bafk-club-membership" }, input_replacement: "latest_wins",
  input_schema: [{ name: "choice", type: "text", enum: ["yes", "no", "abstain"], required: true }], isolation: "shared",
  job_requester_predicate: { is_holder: true }, mode: "aggregate", output_action: "statement",
  output_recipients: { cards: [], job_requester: true, public: true },
  output_schema: [{ name: "yes", type: "integer", clamp: [0, 1000], round_to: 5 }, { name: "no", type: "integer" }],
  parameter_bounds: [{ name: "question", type: "text", regex: "^.{1,280}$", required: true }], platform: "simulator",
  privacy: { k_min: 5 }, program_cid: fx.program_cid, retention: "none",
};
const accepted: AcceptedRuntime[] = [{ accepted_from: "2026-01-01T00:00:00Z", build_recipe_cid: "x", close_compat: "c1", pcr0: fx.accepted_pcr0, platform: "simulator", source_commit: "abc", version: "1.0.0" }];
const allowlist: AllowlistedProgram[] = [{ accepted_from: "2026-01-01T00:00:00Z", audit_report_cid: "bafk-audit", name: "vote", program_cid: fx.program_cid, source_commit: "abc", toolchain: "rust", version: "1.0.0" }];
const config: NotaryConfig = {
  attestationRoots: { "aws-nitro-enclaves": awsNitroRootG1Der(), simulator: b64uDecode(fx.trust_root) }, allowSimulator: true,
  acceptedRuntimesCard: "list-a", programAllowlistCard: "list-b", notaryCardPolicy: "np", acceptedKems: ["x-wing-draft-06"],
};

function announcement(job: NotaryJob, over: Partial<JobAnnouncement> = {}, attName = "good"): JobAnnouncement {
  const u = { ...withoutFields(baseAnn as unknown as Record<string, unknown>, "notary_signature"), job, attestations: [cidOfBytes(doc(attName))], ...over };
  return { ...u, notary_signature: sign(1, u) } as unknown as JobAnnouncement;
}
function reads(over: Partial<NotaryChainReads> = {}, policy: Partial<PolicyRead> = {}, docName = "good"): NotaryChainReads {
  const docs = new Map(Object.keys(fx.docs).map((n) => [cidOfBytes(doc(n)), doc(n)]));
  void docName;
  return {
    nowMs: () => NOW,
    policy: async () => ({ headCid: baseAnn.job.policy_state_cid, stateCids: [baseAnn.job.policy_state_cid], notary: notarySection, approvedNotaries: [CARD1], ...policy }),
    policyAtState: async () => ({ notary: notarySection, approvedNotaries: [CARD1] }),
    satisfies: async () => true,
    notaryCard: async () => ({ policy_id: "np", issuer_card: baseAnn.job.policy_id, platform: "simulator", revoked: false, recipient_pubkey: K_ID, operator_card: "operator-1" }),
    keyExposed: async () => false,
    fetchAttestation: async (cid) => docs.get(cid) ?? new Uint8Array(0),
    ...over,
  };
}
function opts(over: Partial<VerifyJobOptions> = {}): VerifyJobOptions {
  return { announcement: announcement(baseAnn.job), config, reads: reads(), lists: { acceptedRuntimes: accepted, programAllowlist: allowlist }, attestation: [simulator, awsNitroEnclaves], ...over };
}
const code = async (o: VerifyJobOptions) => { const r = await verifyNotaryJob(o); return r.valid ? "valid" : r.code; };
const withAtt = (name: string) => opts({ announcement: announcement(baseAnn.job, {}, name) });
const requesterSigned = (patch: Partial<NotaryJob>): NotaryJob => {
  const u = { ...withoutFields(baseAnn.job as unknown as Record<string, unknown>, "requester_signature"), ...patch };
  return { ...u, requester_signature: sign(4, u) } as unknown as NotaryJob;
};

describe("algorithm W (wallet_sdk.md §7b.2) with real simulator attestations", () => {
  it("accepts a good job and builds the consent from policy and job only", async () => {
    const r = await verifyNotaryJob(opts());
    expect(r.valid).toBe(true);
    if (!r.valid) return;
    expect(r.consent.program).toEqual({ allowlisted: true, name: "vote", version: "1.0.0", auditReport: "bafk-audit" });
    expect(r.consent.collects).toEqual(notarySection.input_schema);
    expect(r.consent.privacy).toEqual({ kMin: 5, transforms: { yes: { clamp: [0, 1000], round_to: 5 } } });
    expect(r.consent.notaries).toEqual([{ notaryCard: CARD1, operatorCard: "operator-1", platform: "simulator" }]);
    expect(r.consent.recipients).toEqual({ public: true, jobRequester: true, cards: [] });
    expect(r.consent.closesAt).toBe(baseAnn.job.closes_at);
  });

  // ---- the six G2 rejections (strategic plan objective G2), each against a real document ----
  it("G2: wrong PCR0 → ATT_RUNTIME_NOT_ACCEPTED", async () => expect(await code(withAtt("wrong_pcr0"))).toBe("ATT_RUNTIME_NOT_ACCEPTED"));
  it("G2: debug-mode attestation → ATT_DEBUG_MODE", async () => expect(await code(withAtt("debug"))).toBe("ATT_DEBUG_MODE"));
  it("G2: program hash ≠ program_cid → ATT_BINDING_MISMATCH", async () => expect(await code(withAtt("wrong_program"))).toBe("ATT_BINDING_MISMATCH"));
  it("G2: mismatched nonce → ATT_NONCE_MISMATCH", async () => expect(await code(withAtt("wrong_nonce"))).toBe("ATT_NONCE_MISMATCH"));
  it("G2: stale attestation → ATT_STALE", async () => expect(await code(withAtt("stale"))).toBe("ATT_STALE"));
  it("G2: notary not in approved_notaries → JOB_NOTARY_NOT_APPROVED", async () =>
    expect(await code(opts({ reads: reads({}, { approvedNotaries: [] }) }))).toBe("JOB_NOTARY_NOT_APPROVED"));
  it("G2: parameters outside parameter_bounds → JOB_PARAMETERS_OUT_OF_BOUNDS", async () => {
    const job = requesterSigned({ parameters: { question: "" } });
    expect(await code(opts({ announcement: announcement(job) }))).toBe("JOB_PARAMETERS_OUT_OF_BOUNDS");
  });

  // ---- remaining W steps ----
  it("W1 malformed announcement", async () => expect(await code(opts({ announcement: { ...baseAnn, extra: 1 } }))).toBe("ANN_MALFORMED"));
  it("W2 requester signature does not verify", async () => {
    const job = { ...baseAnn.job, parameters: { question: "tampered" } } as NotaryJob; // signed over a different question
    expect(await code(opts({ announcement: announcement(job) }))).toBe("JOB_SIGNATURE_INVALID");
  });
  it("W3 policy chain untrusted", async () => expect(await code(opts({ reads: reads({ policy: async () => null }) }))).toBe("JOB_POLICY_UNTRUSTED"));
  it("W4 policy changed since the job was signed", async () =>
    expect(await code(opts({ reads: reads({ policyAtState: async () => ({ notary: { ...notarySection, privacy: { k_min: 1 } }, approvedNotaries: [CARD1] }) }, { headCid: "newer", stateCids: ["newer", baseAnn.job.policy_state_cid] }) }))).toBe("JOB_POLICY_CHANGED"));
  it("W5 requester not permitted", async () => expect(await code(opts({ reads: reads({ satisfies: async () => false }) }))).toBe("JOB_REQUESTER_NOT_PERMITTED"));
  it("W7 min_live outside q..N", async () => {
    const job = requesterSigned({ min_live: 1 });
    expect(await code(opts({ announcement: announcement(job) }))).toBe("JOB_MALFORMED");
  });
  it("W8 job already closed", async () => expect(await code(opts({ reads: reads({ nowMs: () => NOW + 30 * 86_400_000 }) }))).toBe("JOB_CLOSED"));
  it("W9 unsupported KEM", async () => expect(await code(opts({ config: { ...config, acceptedKems: [] as never } }))).toBe("JOB_KEM_UNSUPPORTED"));
  it("W10 revoked notary card", async () =>
    expect(await code(opts({ reads: reads({ notaryCard: async () => ({ policy_id: "np", issuer_card: baseAnn.job.policy_id, platform: "simulator", revoked: true, recipient_pubkey: K_ID, operator_card: "o" }) }) }))).toBe("JOB_NOTARY_NOT_APPROVED"));
  it("W10a exposed notary key", async () => expect(await code(opts({ reads: reads({ keyExposed: async () => true }) }))).toBe("JOB_NOTARY_KEY_EXPOSED"));
  it("W11 announcement signed by a stranger", async () => {
    const forged = { ...announcement(baseAnn.job), notary_signature: sign(9, { x: 1 }) };
    expect(await code(opts({ announcement: forged }))).toBe("ANN_SIGNATURE_INVALID");
  });
  it("W12 epoch below the highest seen", async () => expect(await code(opts({ highestEpochSeen: 1 }))).toBe("ANN_EPOCH_REGRESSION"));
  it("W12 epoch > 0 without a chain", async () => expect(await code(opts({ announcement: announcement(baseAnn.job, { epoch: 1 }) }))).toBe("ANN_EPOCH_REGRESSION"));
  it("W13 attestation bound to another epoch → ATT_BINDING_MISMATCH", async () => expect(await code(withAtt("wrong_epoch"))).toBe("ATT_BINDING_MISMATCH"));
  it("W13 attestation for a key that is not a replica's → ATT_BINDING_MISMATCH", async () => expect(await code(withAtt("stranger_id_key"))).toBe("ATT_BINDING_MISMATCH"));
  it("W13 public_key ≠ SHA-256(job_public_key) → ATT_KEY_MISMATCH", async () => expect(await code(withAtt("wrong_public_key"))).toBe("ATT_KEY_MISMATCH"));
  it("W13 simulator refused in a production configuration → ATT_PLATFORM_NOT_ALLOWED", async () =>
    expect(await code(opts({ config: { ...config, allowSimulator: false } }))).toBe("ATT_PLATFORM_NOT_ALLOWED"));
  it("W13 attestation bytes that do not match their CID are not used", async () =>
    expect(await code(opts({ reads: reads({ fetchAttestation: async () => doc("wrong_pcr0") }) }))).toBe("ATT_MALFORMED"));
  it("W14 shared job whose program is not allowlisted", async () =>
    expect(await code(opts({ lists: { acceptedRuntimes: accepted, programAllowlist: [] } }))).toBe("JOB_PROGRAM_NOT_ALLOWLISTED"));
  it("W15 runtime retired as vulnerable → ATT_RUNTIME_NOT_ACCEPTED", async () =>
    expect(await code(opts({ lists: { acceptedRuntimes: accepted.map((r) => ({ ...r, retired_at: "2027-01-01T00:00:00Z", retire_reason: "vulnerable" as const })), programAllowlist: allowlist } }))).toBe("ATT_RUNTIME_NOT_ACCEPTED"));
});

describe("consent model (wallet_sdk.md §7b.3)", () => {
  it("requester text is shown only as labelled requester text and never merged into other fields", async () => {
    const r = await verifyNotaryJob(opts());
    expect(r.valid).toBe(true);
    if (!r.valid) return;
    expect(baseAnn.job.requester_text).toBe("Vote before Friday");
    expect(r.consent.requesterText).toBe("Vote before Friday");
    const { requesterText, ...rest } = r.consent;
    expect(JSON.stringify(rest)).not.toContain("Vote before Friday");
    void requesterText;
  });
  it("is derived from the policy: changing requester_text changes nothing else", async () => {
    const other = requesterSigned({ requester_text: "Totally different words" });
    const a = await verifyNotaryJob(opts()); // original
    // a re-signed job would need its own attestation; compare the consent builder directly
    const { buildConsent } = await import("../../src/notary/consent.js");
    const mk = (job: NotaryJob) => buildConsent({ job, notary: notarySection, allowlisted: allowlist[0], notaries: [{ notaryCard: CARD1 }], operatorCards: { [CARD1]: "operator-1" }, platform: "simulator" });
    const { requesterText: t1, ...c1 } = mk(baseAnn.job);
    const { requesterText: t2, ...c2 } = mk(other);
    expect(c1).toEqual(c2);
    expect(t1).not.toBe(t2);
    expect(a.valid).toBe(true);
  });
  it("labels a non-allowlisted program and shows the participation disclosure for non-snapshotable predicates", async () => {
    const { buildConsent } = await import("../../src/notary/consent.js");
    const c = buildConsent({ job: baseAnn.job, notary: { ...notarySection, contributor_predicate: { card_field_matches: { field: "x" } } }, allowlisted: undefined, notaries: [], operatorCards: {}, platform: "simulator" });
    expect(c.program).toEqual({ allowlisted: false, label: CUSTOM_PROGRAM_LABEL });
    expect(c.disclosures).toContain(PARTICIPATION_DISCLOSURE);
    const d = buildConsent({ job: baseAnn.job, notary: notarySection, allowlisted: allowlist[0], notaries: [], operatorCards: {}, platform: "simulator" });
    expect(d.disclosures).not.toContain(PARTICIPATION_DISCLOSURE);
  });
  it("derived-card jobs show the revocation-propagation disclosures (propagation §8)", async () => {
    const { buildConsent } = await import("../../src/notary/consent.js");
    const notary: NotarySection = { ...notarySection, output_action: "card", mode: "per_input", derived_card: { min_anonymity_set: 10 }, revocation_propagation: { mode: "sealed_link" } };
    const c = buildConsent({ job: { ...baseAnn.job, parameters: { source_policy: "bafk-source" } }, notary, allowlisted: allowlist[0], notaries: [], operatorCards: {}, platform: "simulator" });
    expect(c.disclosures.some((l) => l.includes("sealed link"))).toBe(true);
    expect(c.disclosures.some((l) => l.includes("at least 10 people"))).toBe(true);
  });
});
