import { describe, it, expect } from "vitest";
import { ml_dsa44 } from "@noble/post-quantum/ml-dsa.js";
import { b64uDecode, canonicalNotary, cidOfBytes, H } from "@membership-card-protocol/wallet-sdk/notary-types";
import { handleCreateJob, handleGetAnnouncement, handleJobStatus } from "../src/handlers/jobs.js";
import { handleSubmitInput, MAX_SEALED_INPUT } from "../src/handlers/inputs.js";
import { HostError } from "../src/context.js";
import { harness, job, JOB_HASH, sealed, flush, PROGRAM, hostPublicKey } from "./helpers.js";
import { vec } from "./helpers.js";

const code = async (p: Promise<unknown>) => { try { await p; return "ok"; } catch (e) { return e instanceof HostError ? e.code : `other:${(e as Error).message}`; } };
const announcement = vec("announcement");

async function keyedJob(h: Awaited<ReturnType<typeof harness>>) {
  await handleCreateJob(h.ctx, { job, program_cid: h.programCid });
}

describe("POST /jobs (notary_host.md §5; lifecycle Phase 2)", () => {
  it("validates, fetches the program, sends create_job with the program bytes and transport hints, and records the job", async () => {
    const h = await harness();
    const r = await handleCreateJob(h.ctx, { job, program_cid: h.programCid });
    expect(r).toEqual({ job_hash: JOB_HASH, status: "keyed" });
    const sent = h.enclave.received.find((m) => m.kind === "create_job")!;
    expect(sent["job"]).toEqual(job);
    expect(Buffer.from(sent["program"] as string, "base64url").equals(Buffer.from(PROGRAM))).toBe(true);
    expect(sent["transport"]).toEqual({ key_config_url: "https://notary.example/ohttp/key-config", relay_target_id: "notary-a" });
    expect(await h.ctx.jobs.get(JOB_HASH)).toMatchObject({ state: "keyed", epoch: 0, programCid: h.programCid, announcement: null });
  });
  it("is idempotent: a second create for the same job does not reach the enclave again", async () => {
    const h = await harness();
    await keyedJob(h);
    expect(await handleCreateJob(h.ctx, { job, program_cid: h.programCid })).toEqual({ job_hash: JOB_HASH, status: "keyed" });
    expect(h.enclave.received.filter((m) => m.kind === "create_job").length).toBe(1);
  });
  it("refuses a malformed body, an extra field, a bad requester signature, a wrong min_live", async () => {
    const h = await harness();
    expect(await code(handleCreateJob(h.ctx, {} as never))).toBe("JOB_MALFORMED");
    expect(await code(handleCreateJob(h.ctx, { job: { ...job, extra: 1 }, program_cid: h.programCid }))).toBe("JOB_MALFORMED");
    expect(await code(handleCreateJob(h.ctx, { job: { ...job, parameters: { question: "tampered" } }, program_cid: h.programCid }))).toBe("JOB_SIGNATURE_INVALID");
    expect(h.enclave.received.filter((m) => m.kind === "create_job").length).toBe(0);
  });
  it("refuses a job none of whose replica cards this operator serves, or whose local card is not approved", async () => {
    expect(await code(handleCreateJob((await harness({}, { cardAddresses: ["cd".repeat(32)] })).ctx, { job, program_cid: (await harness()).programCid }))).toBe("JOB_NOTARY_NOT_APPROVED");
    const h = await harness();
    h.svc.policies.set(job["policy_id"], { notary: { program_cid: h.programCid } as never, approvedNotaries: [] });
    expect(await code(handleCreateJob(h.ctx, { job, program_cid: h.programCid }))).toBe("JOB_NOTARY_NOT_APPROVED");
  });
  it("refuses an unknown policy state, a program_cid that is not the policy's, and program bytes that do not match the CID", async () => {
    const h = await harness();
    h.svc.policies.set(job["policy_id"], null as never);
    expect(await code(handleCreateJob(h.ctx, { job, program_cid: h.programCid }))).toBe("JOB_POLICY_UNTRUSTED");
    const g = await harness();
    expect(await code(handleCreateJob(g.ctx, { job, program_cid: cidOfBytes(new Uint8Array([9])) }))).toBe("JOB_MALFORMED");
    const w = await harness();
    w.svc.ipfs.pinned.set(w.programCid, new TextEncoder().encode("different bytes")); // the provider serves other bytes for the CID
    expect(await code(handleCreateJob(w.ctx, { job, program_cid: w.programCid }))).toBe("ADM_HASH_MISMATCH");
    expect(w.enclave.received.filter((m) => m.kind === "create_job").length).toBe(0);
  });
  it("passes the enclave's rejection code through and records nothing; reports an unavailable enclave as NH_ENCLAVE_UNAVAILABLE", async () => {
    const h = await harness({ createJob: () => ({ reject: "ADM_FEATURE_DISALLOWED" }) });
    expect(await code(handleCreateJob(h.ctx, { job, program_cid: h.programCid }))).toBe("ADM_FEATURE_DISALLOWED");
    expect(await h.ctx.jobs.get(JOB_HASH)).toBeNull();
    const d = await harness();
    d.session.closed = true;
    expect(await code(handleCreateJob(d.ctx, { job, program_cid: d.programCid }))).toBe("NH_ENCLAVE_UNAVAILABLE");
  });
});

describe("announcements and status", () => {
  it("serves the announcement the enclave announces, pinned as exact raw bytes, and the job becomes open", async () => {
    const h = await harness({ createJob: () => ({ epoch: 0, job_public_key: "AA", attestation: "AA", announcement }) });
    await keyedJob(h); await flush();
    expect(await handleGetAnnouncement(h.ctx, JOB_HASH)).toEqual(announcement);
    expect(h.svc.ipfs.pinned.has(cidOfBytes(canonicalNotary(announcement)))).toBe(true);
    expect(await handleJobStatus(h.ctx, JOB_HASH)).toMatchObject({ state: "open", epoch: 0, live_replicas: 1, job_log_head: null });
  });
  it("NH_JOB_UNKNOWN for a job with no announcement or no record; an announcement for an unknown job is ignored", async () => {
    const h = await harness();
    expect(await code(handleGetAnnouncement(h.ctx, JOB_HASH))).toBe("NH_JOB_UNKNOWN");
    await keyedJob(h);
    expect(await code(handleGetAnnouncement(h.ctx, JOB_HASH))).toBe("NH_JOB_UNKNOWN"); // keyed, not yet announced
    expect(await code(handleJobStatus(h.ctx, "x".repeat(43)))).toBe("NH_JOB_UNKNOWN");
    const g = await harness();
    g.enclave.emit({ kind: "announce", req_id: "a", announcement }); await flush();
    expect(await g.ctx.jobs.get(JOB_HASH)).toBeNull();
  });
  it("a malformed announcement from the enclave is not served", async () => {
    const h = await harness();
    await keyedJob(h);
    h.enclave.emit({ kind: "announce", req_id: "a", announcement: { ...announcement, extra: 1 } }); await flush();
    expect(await code(handleGetAnnouncement(h.ctx, JOB_HASH))).toBe("NH_JOB_UNKNOWN");
  });
  it("status counts only live replicas", async () => {
    const h = await harness();
    await keyedJob(h);
    h.session.closed = true;
    expect((await handleJobStatus(h.ctx, JOB_HASH)).live_replicas).toBe(0);
  });
});

describe("POST /jobs/{hash}/inputs (notary_host.md §5–§7; protocol-objects.md §24–§26)", () => {
  const ok = { input_hash: "IH", receipt_sealed: "c2VhbGVkLXJlY2VpcHQ" };
  async function open(script = { submitInput: () => ok }) { const h = await harness(script); await keyedJob(h); return h; }

  it("stores the ciphertext, signs a host receipt with K_host, forwards the exact sealed input, and returns receipt_sealed untouched", async () => {
    const h = await open();
    const r = await handleSubmitInput(h.ctx, JOB_HASH, sealed);
    const inputHash = H(sealed);
    expect(r.receipt_sealed).toBe(ok.receipt_sealed);
    expect(r.host_receipt).toMatchObject({ type: "notary.host_receipt.v1", input_hash: inputHash, job_hash: JOB_HASH, epoch: sealed["epoch"], received_at: "2026-11-12T10:00:00.000Z" });
    expect(r.host_receipt.host_signature.public_key).toBe(hostPublicKey);
    const { host_signature, ...unsigned } = r.host_receipt as any;
    expect(ml_dsa44.verify(b64uDecode(host_signature.signature), canonicalNotary(unsigned), b64uDecode(host_signature.public_key))).toBe(true);
    expect((await h.ctx.inputs.get(JOB_HASH, sealed["epoch"], inputHash))?.sealedInput).toEqual(sealed);
    expect(await h.ctx.receipts.get(inputHash)).toEqual(r.host_receipt);
    const fwd = h.enclave.received.find((m) => m.kind === "submit_input")!;
    expect(fwd["sealed_input"]).toEqual(sealed); // exactly what arrived: the host cannot and does not alter it
  });
  it("a replay of the same sealed input is the same input_hash, so storage is idempotent", async () => {
    const h = await open();
    await handleSubmitInput(h.ctx, JOB_HASH, sealed); await handleSubmitInput(h.ctx, JOB_HASH, sealed);
    expect((await h.ctx.inputs.list(JOB_HASH)).length).toBe(1);
  });
  it("NH_INPUT_TOO_LARGE above 256 KiB; nothing stored", async () => {
    const h = await open();
    expect(await code(handleSubmitInput(h.ctx, JOB_HASH, { ...sealed, ct: "A".repeat(MAX_SEALED_INPUT) }))).toBe("NH_INPUT_TOO_LARGE");
    expect((await h.ctx.inputs.list(JOB_HASH)).length).toBe(0);
  });
  it("NH_JOB_UNKNOWN, NH_JOB_CLOSED, INPUT_MALFORMED, INPUT_WRONG_JOB", async () => {
    const h = await open();
    expect(await code(handleSubmitInput(h.ctx, "x".repeat(43), sealed))).toBe("NH_JOB_UNKNOWN");
    expect(await code(handleSubmitInput(h.ctx, JOB_HASH, { ...sealed, extra: 1 }))).toBe("INPUT_MALFORMED");
    expect(await code(handleSubmitInput(h.ctx, JOB_HASH, { ...sealed, type: "notary.job.v1" }))).toBe("INPUT_MALFORMED");
    expect(await code(handleSubmitInput(h.ctx, JOB_HASH, { ...sealed, job_hash: "x".repeat(43) }))).toBe("INPUT_WRONG_JOB");
    const stored = (await h.ctx.jobs.get(JOB_HASH))!;
    await h.ctx.jobs.retire(stored, "finalized");
    expect(await code(handleSubmitInput(h.ctx, JOB_HASH, sealed))).toBe("NH_JOB_CLOSED");
  });
  it("a storage failure issues NO receipt, stores nothing, alerts, and never reaches the enclave", async () => {
    const h = await open();
    h.kv.failNextWrite();
    expect(await code(handleSubmitInput(h.ctx, JOB_HASH, sealed))).toBe("NH_STORAGE_FAILED");
    expect(await h.ctx.receipts.get(H(sealed))).toBeNull();
    expect(h.enclave.received.some((m) => m.kind === "submit_input")).toBe(false);
    expect(h.svc.alerts.map((a) => a.code)).toContain("storage_failure");
  });
  it("an input the enclave cannot decrypt is dropped, with the enclave's code and no receipt returned", async () => {
    const h = await open({ submitInput: () => ({ error: "INPUT_UNDECRYPTABLE" }) } as never);
    expect(await code(handleSubmitInput(h.ctx, JOB_HASH, sealed))).toBe("INPUT_UNDECRYPTABLE");
    expect((await h.ctx.inputs.list(JOB_HASH)).length).toBe(0);
  });
  it("an unavailable enclave keeps the ciphertext (the wallet retries) and returns NH_ENCLAVE_UNAVAILABLE", async () => {
    const h = await open();
    h.session.closed = true;
    expect(await code(handleSubmitInput(h.ctx, JOB_HASH, sealed))).toBe("NH_ENCLAVE_UNAVAILABLE");
    expect((await h.ctx.inputs.list(JOB_HASH)).length).toBe(1);
  });
  it("a hung enclave times out as NH_ENCLAVE_UNAVAILABLE", async () => {
    const h = await open();
    h.enclave.silent = true;
    expect(await code(handleSubmitInput(h.ctx, JOB_HASH, sealed))).toBe("NH_ENCLAVE_UNAVAILABLE");
  });
});
