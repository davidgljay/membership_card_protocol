import { describe, it, expect, vi } from "vitest";
import { sha256 } from "@noble/hashes/sha256";
import { ml_dsa44 } from "@noble/post-quantum/ml-dsa.js";
import { mlDsa44Verify } from "@membership-card-protocol/verifier";
import { assertNotaryObject, b64uDecode, b64uEncode, canonicalNotary, cardPointer, digestFromCid, withoutFields } from "@membership-card-protocol/verifier/notary";
import { buildNotaryJob, sendNotaryJob, JobBuildError } from "../../src/notary/job.js";
import { buildNotaryJobLink, parseNotaryJobLink } from "../../src/notary/link.js";
import { watchNotaryJobsOnce, RECEIPT_WAIT_MS, RETENTION_AFTER_NOTARIZATION_MS } from "../../src/notary/watch.js";
import type { StoredNotaryInput, WatchDeps } from "../../src/notary/watch.js";
import type { NotaryInput } from "../../src/notary/types.js";

const kp = ml_dsa44.keygen(sha256(new TextEncoder().encode("requester-key")));
const requester = { publicKey: kp.publicKey, sign: (m: Uint8Array) => ml_dsa44.sign(m, kp.secretKey, { extraEntropy: false }) };
const CARD_A = "aa".repeat(32), CARD_B = "bb".repeat(32);
const base = {
  policyId: "bafkreipolicy", policyStateCid: "bafkreistate", replicaSet: [{ notary_card: CARD_A, instances: 2 }, { notary_card: CARD_B, instances: 1 }],
  opensAt: "2026-11-12T10:00:00Z", closesAt: "2026-11-19T10:00:00Z", createdAt: "2026-11-12T09:00:00Z", nonce: new Uint8Array(16).fill(3), requester,
};

describe("job requesting (lifecycle Phase 2 steps 14–15)", () => {
  it("builds a signed, strictly-shaped job whose hash is the digest of its pinned CID", async () => {
    const b = await buildNotaryJob({ ...base, parameters: { question: "Adopt the budget?" }, requesterText: "Vote please" });
    assertNotaryObject(b.job, "notary.job.v1");
    expect(b.job.requester_card).toBe(cardPointer(kp.publicKey));
    expect(b.job.min_live).toBe(2); // N = 3, q = 2
    expect(mlDsa44Verify(kp.publicKey, canonicalNotary(withoutFields(b.job as never, "requester_signature")), b64uDecode(b.job.requester_signature.signature))).toBe(true);
    expect(b64uEncode(digestFromCid(b.jobCid))).toBe(b.jobHash); // job_hash = H(job) = digest of the raw-codec CID
    expect(b.job.requester_text).toBe("Vote please");
    expect((await buildNotaryJob(base)).jobHash).toBe((await buildNotaryJob(base)).jobHash); // deterministic given the same inputs
  });
  it("per-input jobs carry ends_at and key_period and no closes_at", async () => {
    const { closesAt, ...rest } = base; void closesAt;
    const b = await buildNotaryJob({ ...rest, endsAt: "2027-01-01T00:00:00Z", keyPeriod: "P7D" });
    expect(b.job).toMatchObject({ ends_at: "2027-01-01T00:00:00Z", key_period: "P7D" });
    expect("closes_at" in b.job).toBe(false);
  });
  it("refuses malformed jobs locally", async () => {
    const bad = async (o: object) => { await expect(buildNotaryJob({ ...base, ...o })).rejects.toBeInstanceOf(JobBuildError); };
    await bad({ replicaSet: [] });
    await bad({ minLive: 1 });                       // below the quorum of 2
    await bad({ minLive: 4 });                       // above N
    await bad({ nonce: new Uint8Array(15) });
    await bad({ requesterText: "x".repeat(1001) });
    await bad({ closesAt: "2026-11-12T10:00:00Z" }); // not after opens_at
    await bad({ endsAt: "2027-01-01T00:00:00Z" });   // both modes
    await bad({ closesAt: undefined });              // neither mode
    await bad({ opensAt: "yesterday" });
  });
  it("sends the job to every host and reports each result; a host answering with another job_hash is a failure", async () => {
    const b = await buildNotaryJob(base);
    const post = vi.fn(async (url: string) => (url.startsWith("https://c") ? { job_hash: "other", status: "keyed" } : url.startsWith("https://b") ? Promise.reject(new Error("503")) : { job_hash: b.jobHash, status: "keyed" }));
    const r = await sendNotaryJob({ built: b, programCid: "bafkreiprog", hosts: ["https://a.example/", "https://b.example", "https://c.example"], post });
    expect(r).toEqual([{ host: "https://a.example/", ok: true, status: "keyed" }, { host: "https://b.example", ok: false, reason: "503" }, { host: "https://c.example", ok: false, reason: "host returned a different job_hash" }]);
    expect(post).toHaveBeenCalledWith("https://a.example/jobs", { job: b.job, program_cid: "bafkreiprog" });
  });
});

describe("share links (lifecycle Phase 3)", () => {
  const j = b64uEncode(new Uint8Array(32).fill(4));
  it("round-trips", () => {
    const link = buildNotaryJobLink({ jobHash: j, relayTargetId: "notary-a" });
    expect(link).toBe(`mcard://notary-job?j=${j}&h=notary-a`);
    expect(parseNotaryJobLink(link)).toEqual({ ok: true, link: { jobHash: j, relayTargetId: "notary-a" } });
  });
  it("rejects anything else", () => {
    for (const bad of [`https://x/notary-job?j=${j}&h=a`, `mcard://notary-job?j=${j}`, `mcard://notary-job?j=${j}&h=a&x=1`, `mcard://notary-job?j=${j}&j=${j}&h=a`,
      `mcard://notary-job?j=short&h=a`, `mcard://notary-job?j=${j}&h=a b`, `mcard://notary-job?j=${j}&h=a#frag`, `mcard://notary-job?j=${j}&h=`, "mcard://notary-job", `mcard://other?j=${j}&h=a`])
      expect(parseNotaryJobLink(bad).ok, bad).toBe(false);
    expect(() => buildNotaryJobLink({ jobHash: "x", relayTargetId: "a" })).toThrow();
  });
});

describe("watching and resubmitting (wallet_sdk.md §7b.5)", () => {
  const signed = { type: "notary.input.v1", job_hash: "JH", payload: { choice: "yes" } } as unknown as NotaryInput;
  const stored = (o: Partial<StoredNotaryInput> = {}): StoredNotaryInput => ({ jobHash: "JH", signed, inputHash: "IH", epoch: 0, submittedAtMs: 0, hasValidationReceipt: true, ...o });
  function deps(items: StoredNotaryInput[], o: { epoch?: number; reason?: string; valid?: boolean; now?: number; submit?: boolean; ann?: unknown | null } = {}) {
    const saved: StoredNotaryInput[] = [], removed: string[] = [], notes: string[] = [];
    const resubmit = vi.fn(async () => (o.submit === false ? { submitted: false as const, code: "NOTARY_NO_RECEIPT", reason: "x" } : { submitted: true as const, inputHash: "IH2", hostReceipt: {} as never, validationReceipt: {} as never }));
    const d: WatchDeps = {
      nowMs: () => o.now ?? 1_000_000, list: async () => items, save: async (s) => { saved.push(s); }, remove: async (j, i) => { removed.push(`${j}/${i}`); },
      fetchAnnouncement: async () => (o.ann === undefined ? { epoch: o.epoch ?? 0, epoch_reason: o.reason } : o.ann),
      verify: async () => (o.valid === false ? { valid: false, code: "ATT_STALE", reason: "r" } : { valid: true, jobHash: "JH", epoch: o.epoch ?? 0, consent: {} as never, warnings: [] }),
      resubmit, notify: (m) => notes.push(m),
    };
    return { d, saved, removed, notes, resubmit };
  }
  it("re-seals the stored signed input to a higher epoch without re-signing, and tells the user about a total loss", async () => {
    const x = deps([stored()], { epoch: 1, reason: "total_loss" });
    const r = await watchNotaryJobsOnce(x.d);
    expect(r).toEqual([{ jobHash: "JH", inputHash: "IH", action: "resubmitted", epoch: 1, totalLoss: true }]);
    expect(x.resubmit.mock.calls[0]![0].signed).toBe(signed); // the same signed object: not re-signed, no prompt
    expect(x.notes.length).toBe(1);
    expect(x.saved[0]).toMatchObject({ epoch: 1, hasValidationReceipt: true });
  });
  it("a key_period epoch resubmits silently", async () => {
    const x = deps([stored()], { epoch: 2, reason: "key_period" });
    expect((await watchNotaryJobsOnce(x.d))[0]).toMatchObject({ action: "resubmitted", totalLoss: false });
    expect(x.notes).toEqual([]);
  });
  it("does nothing when the epoch is unchanged and a receipt is held", async () => {
    const x = deps([stored()], { epoch: 0 });
    expect((await watchNotaryJobsOnce(x.d))[0]!.action).toBe("no_change");
    expect(x.resubmit).not.toHaveBeenCalled();
  });
  it("resubmits in the same epoch when the validation receipt is still missing after 10 minutes, not before", async () => {
    const waiting = stored({ hasValidationReceipt: false, submittedAtMs: 1_000_000 });
    expect((await watchNotaryJobsOnce(deps([waiting], { now: 1_000_000 + RECEIPT_WAIT_MS - 1 }).d))[0]!.action).toBe("no_change");
    const x = deps([waiting], { now: 1_000_000 + RECEIPT_WAIT_MS });
    expect((await watchNotaryJobsOnce(x.d))[0]!.action).toBe("resubmitted");
  });
  it("never resubmits after an announcement that fails algorithm W, and keeps the stored input on a failed resubmit", async () => {
    const rej = deps([stored()], { epoch: 1, valid: false });
    expect((await watchNotaryJobsOnce(rej.d))[0]).toMatchObject({ action: "announcement_rejected", code: "ATT_STALE" });
    expect(rej.resubmit).not.toHaveBeenCalled();
    const fail = deps([stored()], { epoch: 1, submit: false });
    expect((await watchNotaryJobsOnce(fail.d))[0]).toMatchObject({ action: "resubmit_failed" });
    expect(fail.saved).toEqual([]);
    expect((await watchNotaryJobsOnce(deps([stored()], { ann: null }).d))[0]!.action).toBe("no_change");
  });
  it("keeps inputs for 7 days after a notarization, then prunes them", async () => {
    const seen = 5_000;
    const keep = deps([stored({ notarizationSeenAtMs: seen })], { now: seen + RETENTION_AFTER_NOTARIZATION_MS - 1 });
    expect((await watchNotaryJobsOnce(keep.d))[0]!.action).toBe("no_change");
    const prune = deps([stored({ notarizationSeenAtMs: seen })], { now: seen + RETENTION_AFTER_NOTARIZATION_MS });
    expect((await watchNotaryJobsOnce(prune.d))[0]!.action).toBe("pruned");
    expect(prune.removed).toEqual(["JH/IH"]);
  });
});
