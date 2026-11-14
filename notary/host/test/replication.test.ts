/**
 * The host's part in replication (step 6.3; notary_host.md §11): relaying log records, anchors and announcements to
 * peer hosts and the other local enclaves; learning which local instance holds a job from the records; ciphertext
 * sync (`need_inputs`, `store_input`) with the host's own hash check; the peer directory and ticks; asynchronous close;
 * the one-originator rule; operator handoff and shutdown routes.
 */
import { describe, expect, it } from "vitest";
import { b64uEncode, canonicalNotary, cardPointer, cidOfBytes, H } from "@membership-card-protocol/wallet-sdk/notary-types";
import { ml_dsa44 } from "@noble/post-quantum/ml-dsa.js";
import { handleCreateJob } from "../src/handlers/jobs.js";
import { handleSubmitInput } from "../src/handlers/inputs.js";
import { directoryTick, handleOperatorHandoff, handleOperatorShutdown, handlePeerPost, needInputs, tickTick } from "../src/handlers/replication.js";
import { closeTick, newSchedulerState } from "../src/schedulers/index.js";
import { flush, harness, job, JOB_HASH, kEnclaveInst, NOTARY_CARD, sealed } from "./helpers.js";

const sig = { public_key: "AA", signature: "AA" };
const record = (seq: number, kind: string, body: Record<string, unknown>, instance = "writer") => {
  const r = { at: "2026-11-12T10:00:00Z", body, instance, instance_signature: sig, job_hash: JOB_HASH, kind, notary_signature: sig, seq, type: "notary.job_log.v1", ...(seq > 0 ? { prev: "bafkreiprev" } : {}) };
  const bytes = canonicalNotary(r);
  return { r, bytes, cid: cidOfBytes(bytes), b64: b64uEncode(bytes) };
};
const handoffTo = (to: string) => ({ epoch: 0, from_attestation: "bafkreia", from_instance: "writer", job_hash: JOB_HASH, pcr0_from: "AA", pcr0_to: "AA", receiver_signature: sig,
  scope: "job", state_hash: "AA", state_version: 0, at: "2026-11-12T10:00:00Z", to_attestation: "bafkreib", to_instance: to, to_notary_card: NOTARY_CARD, type: "notary.handoff.v1" });
const code = async (p: Promise<unknown>) => { try { await p; return "ok"; } catch (e) { return (e as { code?: string }).code; } };
const TOKEN = `Bearer ${"t".repeat(40)}`;

describe("relaying the log (R2)", () => {
  it("a record the local enclave publishes is indexed and sent to every peer host; one naming a local instance adds it to the job's replicas", async () => {
    const h = await harness();
    await h.ctx.jobs.put({ job, jobHash: JOB_HASH, programCid: "p", announcement: null, epoch: 0, replicas: [], state: "keyed", logHead: null });
    const rec = record(1, "handoff", handoffTo(kEnclaveInst));
    h.enclave.emit({ kind: "publish", req_id: "p1", object: rec.b64, pin: true }); await flush();
    expect(h.svc.peerSends.some((p) => (p.body as { kind?: string }).kind === "log_record" && (p.body as { record?: string }).record === rec.b64)).toBe(true);
    expect((await h.ctx.jobs.get(JOB_HASH))!.replicas).toEqual([kEnclaveInst]);
    expect((await h.ctx.logs.list(JOB_HASH)).map((e) => e.seq)).toEqual([1]);
    const lost = record(2, "replica_lost", { instance: kEnclaveInst });
    h.enclave.emit({ kind: "publish", req_id: "p2", object: lost.b64, pin: true }); await flush();
    expect((await h.ctx.jobs.get(JOB_HASH))!.replicas).toEqual([]);
  });
  it("an anchor of the local enclave's record goes to peer hosts with the record bytes", async () => {
    const h = await harness();
    const rec = record(0, "opened", { attestations: [] });
    h.enclave.emit({ kind: "publish", req_id: "p", object: rec.b64, pin: true }); await flush();
    h.enclave.emit({ kind: "eas_anchor", req_id: "a", record_cid: rec.cid, scope_id: JOB_HASH, seq: 0 }); await flush(); await flush();
    expect(h.enclave.received.find((m) => m.kind === "anchor_receipt")).toMatchObject({ scope_id: JOB_HASH, seq: 0 });
    expect(h.svc.peerSends.find((p) => (p.body as { kind?: string }).kind === "anchor")?.body).toMatchObject({ scope_id: JOB_HASH, seq: 0, record: rec.b64 });
  });
  it("POST /peer log_record and anchor reach the local enclave; a record that isn't one, or names another seq, is refused", async () => {
    const h = await harness();
    const rec = record(3, "replicated", { instance: "x", attestation: "bafkreia" });
    await handlePeerPost(h.ctx, { kind: "log_record", scope_id: JOB_HASH, seq: 3, record: rec.b64 });
    expect(h.enclave.received.at(-1)).toMatchObject({ kind: "log_record", scope_id: JOB_HASH, seq: 3, record: rec.b64 });
    await handlePeerPost(h.ctx, { kind: "anchor", scope_id: JOB_HASH, seq: 3, record: rec.b64, tx_receipt: "0xabc" });
    expect(h.enclave.received.at(-1)).toMatchObject({ kind: "anchor_receipt", scope_id: JOB_HASH, seq: 3, tx_receipt: "0xabc", record: rec.b64 });
    expect(await code(handlePeerPost(h.ctx, { kind: "log_record", scope_id: JOB_HASH, seq: 4, record: rec.b64 }))).toBe("NH_MALFORMED");
    expect(await code(handlePeerPost(h.ctx, { kind: "log_record", scope_id: JOB_HASH, seq: 3, record: b64uEncode(canonicalNotary({ type: "x" })) }))).toBe("NH_MALFORMED");
    expect(await code(handlePeerPost(h.ctx, { kind: "nonsense" }))).toBe("NH_MALFORMED");
  });
  it("an announcement relayed by a peer host makes the job open here; an older epoch never replaces a newer one", async () => {
    const h = await harness();
    await h.ctx.jobs.put({ job, jobHash: JOB_HASH, programCid: "p", announcement: null, epoch: 0, replicas: [], state: "keyed", logHead: null });
    const ann = (epoch: number) => ({ attestations: ["bafkreia"], epoch, issued_at: "2026-11-12T10:00:00Z", job, job_public_key: "AA", notary_signature: sig, transport: { key_config_url: "u", relay_target_id: "t" }, type: "notary.announcement.v1", ...(epoch > 0 ? { epoch_reason: "total_loss", prev_announcement: "bafkreiprev" } : {}) });
    await handlePeerPost(h.ctx, { kind: "announce", announcement: ann(1) });
    expect(await h.ctx.jobs.get(JOB_HASH)).toMatchObject({ state: "open", epoch: 1 });
    await handlePeerPost(h.ctx, { kind: "announce", announcement: ann(0) });
    expect((await h.ctx.jobs.get(JOB_HASH))!.epoch).toBe(1);
  });
});

describe("ciphertext sync (Q8, R4)", () => {
  it("need_inputs keeps only what hashes to the name asked for; POST /peer inputs serves what is stored", async () => {
    const h = await harness();
    const ih = H(sealed);
    const forged = { ...sealed, ct: "Zm9yZ2Vk" };
    h.svc.peerAnswers.set("https://peer.example", () => ({ inputs: [forged, sealed] }));
    expect(await needInputs(h.ctx, { kind: "need_inputs", req_id: "n", job_hash: sealed.job_hash, epoch: sealed.epoch, hashes: [ih, H(forged).replace(/^./, "A")] })).toBe(1);
    expect(await h.ctx.inputs.get(sealed.job_hash, sealed.epoch, ih)).toMatchObject({ sealedInput: sealed });
    expect(await h.ctx.inputs.list(sealed.job_hash)).toHaveLength(1);
    expect(h.ctx.restream.has(sealed.job_hash)).toBe(true);
    expect(await handlePeerPost(h.ctx, { kind: "inputs", job_hash: sealed.job_hash, epoch: sealed.epoch, hashes: [ih, "nope"] })).toEqual({ inputs: [sealed] });
  });
  it("store_input stores an acknowledged input only when the enclave named its hash", async () => {
    const h = await harness();
    h.enclave.emit({ kind: "store_input", req_id: "s", job_hash: sealed.job_hash, epoch: sealed.epoch, input_hash: "wrong", sealed_input: sealed }); await flush();
    expect(await h.ctx.inputs.list(sealed.job_hash)).toHaveLength(0);
    h.enclave.emit({ kind: "store_input", req_id: "s", job_hash: sealed.job_hash, epoch: sealed.epoch, input_hash: H(sealed), sealed_input: sealed }); await flush();
    expect(await h.ctx.inputs.list(sealed.job_hash)).toHaveLength(1);
  });
});

describe("directory, ticks, routing (Q5, Q6)", () => {
  it("each enclave gets local and peer instances; peer_send then goes to the host that serves the instance", async () => {
    const h = await harness();
    h.ctx.instanceKeys.set(kEnclaveInst, "TU9DS19JTlNU");
    h.svc.peerAnswers.set("https://peer.example", () => ({ peers: [{ instance: "remote-1", notary_card: "ab".repeat(32), inst_pubkey: "UkVN", attestation: "", host_url: "https://ignored" }] }));
    await directoryTick(h.ctx);
    const d = h.enclave.received.find((m) => m.kind === "peer_directory")!;
    expect((d["peers"] as { instance: string; host_url: string }[]).map((p) => [p.instance, p.host_url])).toEqual([[kEnclaveInst, "https://notary.example"], ["remote-1", "https://peer.example"]]);
    h.enclave.emit({ kind: "peer_send", req_id: "ps", to_instance: "remote-1", bytes: "QUJD" }); await flush();
    expect(h.svc.peerSends.at(-1)).toMatchObject({ url: "https://peer.example", body: { to_instance: "remote-1", from_instance: kEnclaveInst, bytes: "QUJD" } });
    expect(await handlePeerPost(h.ctx, { kind: "directory" })).toEqual({ peers: [{ instance: kEnclaveInst, notary_card: NOTARY_CARD, inst_pubkey: "TU9DS19JTlNU", attestation: "", host_url: "https://notary.example" }] });
    await tickTick(h.ctx);
    expect(h.enclave.received.at(-1)).toMatchObject({ kind: "tick" });
    expect(Object.keys(h.enclave.received.at(-1)!).sort()).toEqual(["kind", "req_id"]);
  });
});

describe("jobs across hosts", () => {
  it("only the host serving replica_set[0] originates; another records the job and waits for the handoff (R12)", async () => {
    const other = "ef".repeat(32);
    const kp = ml_dsa44.keygen(new Uint8Array(32).fill(5));
    const pk = b64uEncode(kp.publicKey);
    const unsigned = { ...job, replica_set: [{ instances: 1, notary_card: NOTARY_CARD }, { instances: 1, notary_card: other }], min_live: 2, requester_card: cardPointer(kp.publicKey), requester_pubkey: pk } as Record<string, unknown>;
    delete unsigned["requester_signature"];
    const j2 = { ...unsigned, requester_signature: { public_key: pk, signature: b64uEncode(ml_dsa44.sign(canonicalNotary(unsigned), kp.secretKey)) } };
    const second = await harness({}, { cardAddresses: [other] });
    second.svc.policies.set(job["policy_id"], { notary: { program_cid: second.programCid } as never, approvedNotaries: [NOTARY_CARD, other] });
    expect(await handleCreateJob(second.ctx, { job: j2, program_cid: second.programCid })).toEqual({ job_hash: H(j2), status: "awaiting_handoff" });
    expect(second.enclave.received.some((m) => m.kind === "create_job")).toBe(false);
    expect(await second.ctx.jobs.get(H(j2))).toMatchObject({ state: "keyed", replicas: [] });
    const first = await harness({}, { cardAddresses: [NOTARY_CARD] });
    first.svc.policies.set(job["policy_id"], { notary: { program_cid: first.programCid } as never, approvedNotaries: [NOTARY_CARD, other] });
    expect(await handleCreateJob(first.ctx, { job: j2, program_cid: first.programCid })).toEqual({ job_hash: H(j2), status: "keyed" });
    expect(first.enclave.received.some((m) => m.kind === "create_job")).toBe(true);
  });
  it("after close_pending the host doesn't stream again until need_inputs brought ciphertexts; a late job_closed is pinned", async () => {
    const h = await harness({ closeChunk: () => ({ pending: true }) });
    await h.ctx.jobs.put({ job, jobHash: JOB_HASH, programCid: "p", announcement: {}, epoch: 0, replicas: [kEnclaveInst], state: "open", logHead: null });
    const st = newSchedulerState();
    st.chainTimeMs = Date.parse(String(job["closes_at"])) + 1;
    await closeTick(h.ctx, st);
    await closeTick(h.ctx, st);
    expect(h.enclave.received.filter((m) => m.kind === "close_chunk")).toHaveLength(1);
    h.ctx.restream.add(JOB_HASH);
    await closeTick(h.ctx, st);
    expect(h.enclave.received.filter((m) => m.kind === "close_chunk")).toHaveLength(2);
    const n = { type: "notary.notarization.v1", late: true };
    h.enclave.emit({ kind: "job_closed", req_id: "close-x", notarization: n, record: null, outputs: [{ to: "r" }] }); await flush();
    expect(h.svc.ipfs.pinned.has(cidOfBytes(canonicalNotary(n)))).toBe(true);
    expect(h.svc.delivered).toEqual([{ to: "r" }]);
  });
  it("submit_input waits longer than the session timeout for a quorum answer", async () => {
    const h = await harness();
    await h.ctx.jobs.put({ job, jobHash: JOB_HASH, programCid: "p", announcement: {}, epoch: 0, replicas: [kEnclaveInst], state: "open", logHead: null });
    h.enclave.silent = true;
    const p = handleSubmitInput(h.ctx, JOB_HASH, sealed);
    const late = new Promise((r) => setTimeout(r, 300)); // > the 200 ms session timeout
    await late;
    const req = h.enclave.received.find((m) => m.kind === "submit_input")!;
    h.enclave.emit({ kind: "input_result", req_id: req.req_id, input_hash: H(sealed), receipt_sealed: "UkVD" });
    expect((await p).receipt_sealed).toBe("UkVD");
  });
});

describe("operator routes (R5)", () => {
  it("handoff and shutdown need the operator token and reach the named instance", async () => {
    const h = await harness();
    expect(await code(handleOperatorHandoff(h.ctx, "Bearer no", { scope: "identity", card: NOTARY_CARD, to_instance: "x" }))).toBe("NH_UNAUTHORIZED");
    expect(await handleOperatorHandoff(h.ctx, TOKEN, { scope: "identity", card: NOTARY_CARD, to_instance: "new-inst" })).toEqual({ status: "started" });
    expect(h.enclave.received.at(-1)).toMatchObject({ kind: "start_handoff", scope: "identity", card: NOTARY_CARD, to_instance: "new-inst" });
    expect(h.ctx.instanceCards.get("new-inst")).toBe(NOTARY_CARD);
    expect(await code(handleOperatorHandoff(h.ctx, TOKEN, { scope: "job", card: NOTARY_CARD, to_instance: "x" }))).toBe("MISSING_FIELD");
    expect(await code(handleOperatorShutdown(h.ctx, TOKEN, { instance: "nobody" }))).toBe("NH_ENCLAVE_UNAVAILABLE");
    expect(await handleOperatorShutdown(h.ctx, TOKEN, { instance: kEnclaveInst })).toEqual({ status: "stopped" });
    expect(h.enclave.received.at(-1)).toMatchObject({ kind: "shutdown" });
  });
});
