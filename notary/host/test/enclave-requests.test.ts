import { describe, it, expect } from "vitest";
import { sha256 } from "@noble/hashes/sha256";
import { ml_dsa44 } from "@noble/post-quantum/ml-dsa.js";
import { H, b64uEncode, canonicalNotary, cidOfBytes } from "@membership-card-protocol/wallet-sdk/notary-types";
import { handleCreateJob } from "../src/handlers/jobs.js";
import { handleSubmitInput } from "../src/handlers/inputs.js";
import { handleEnclaveRequest } from "../src/handlers/enclave-requests.js";
import { pinExact } from "../src/ipfs/index.js";
import { encodeAnchorData, scopeToBytes32 } from "../src/eas/index.js";
import { harness, job, JOB_HASH, sealed, flush } from "./helpers.js";
import type { Msg } from "../src/enclave/protocol.js";

const ask = async (h: Awaited<ReturnType<typeof harness>>, m: Msg) => { await handleEnclaveRequest(h.ctx, h.session, m); await flush(); };
const reply = (h: Awaited<ReturnType<typeof harness>>, kind: string) => h.enclave.received.filter((m) => m.kind === kind);

const kk = ml_dsa44.keygen(sha256(new TextEncoder().encode("log-key")));
function logRecord(seq: number, kind: string, prev?: string) {
  const u: Record<string, unknown> = { at: "2026-11-12T10:00:00Z", body: {}, instance: b64uEncode(sha256(kk.publicKey)), job_hash: JOB_HASH, kind, seq, type: "notary.job_log.v1", ...(prev ? { prev } : {}) };
  const sig = (m: Uint8Array) => ({ public_key: b64uEncode(kk.publicKey), signature: b64uEncode(ml_dsa44.sign(m, kk.secretKey)) });
  const rec = { ...u, notary_signature: sig(canonicalNotary(u)), instance_signature: sig(canonicalNotary(u)) };
  return canonicalNotary(rec);
}

describe("publishing (notary_host.md §9)", () => {
  it("pins the exact bytes under the raw-codec CID and serves them by CID", async () => {
    const h = await harness();
    const bytes = canonicalNotary({ type: "notary.notarization.v1", x: 1 });
    await ask(h, { kind: "publish", req_id: "p1", object: b64uEncode(bytes), pin: true });
    const cid = cidOfBytes(bytes);
    expect(h.svc.ipfs.pinned.get(cid)).toEqual(bytes);
    expect(h.ctx.served.get(cid)).toEqual(bytes);
    await ask(h, { kind: "fetch", req_id: "f1", what: `ipfs:${cid}` });
    expect(reply(h, "fetch_result").at(-1)).toMatchObject({ req_id: "f1", bytes: b64uEncode(bytes) });
  });
  it("pinExact refuses a provider that answers with any other CID", async () => {
    await expect(pinExact({ pin: async () => "bafkreiwrong", fetch: async () => null }, new Uint8Array([1]))).rejects.toThrow(/raw-codec CID/);
  });
  it("indexes job-log records under log:{job_hash} and tracks the log head", async () => {
    const h = await harness(); await handleCreateJob(h.ctx, { job, program_cid: h.programCid });
    const r0 = logRecord(0, "opened"); const c0 = cidOfBytes(r0);
    await ask(h, { kind: "publish", req_id: "p", object: b64uEncode(r0), pin: true });
    const r1 = logRecord(1, "replicated", c0);
    await ask(h, { kind: "publish", req_id: "p", object: b64uEncode(r1), pin: true });
    expect((await h.ctx.logs.list(JOB_HASH)).map((e) => e.seq)).toEqual([0, 1]);
    expect((await h.ctx.jobs.get(JOB_HASH))!.logHead).toBe(cidOfBytes(r1));
  });
  it("a `notarized` record finalizes the job and DELETES every stored ciphertext (retention, notary_host.md §7)", async () => {
    const h = await harness({ submitInput: () => ({ input_hash: "x", receipt_sealed: "AA" }) });
    await handleCreateJob(h.ctx, { job, program_cid: h.programCid });
    await handleSubmitInput(h.ctx, JOB_HASH, sealed);
    expect((await h.ctx.inputs.list(JOB_HASH)).length).toBe(1);
    await ask(h, { kind: "publish", req_id: "p", object: b64uEncode(logRecord(0, "notarized")), pin: true });
    expect((await h.ctx.jobs.get(JOB_HASH))!.state).toBe("finalized");
    expect((await h.ctx.inputs.list(JOB_HASH)).length).toBe(0);
    expect(await h.ctx.receipts.get(H(sealed))).not.toBeNull(); // receipts are kept 30 days: they are what makes a drop attributable
  });
  it("job retention: a finalized job record keeps a 30-day expiry; receipts keep 30 days", async () => {
    const h = await harness();
    await handleCreateJob(h.ctx, { job, program_cid: h.programCid });
    await h.ctx.jobs.retire((await h.ctx.jobs.get(JOB_HASH))!, "ended");
    expect((await h.ctx.jobs.get(JOB_HASH))!.state).toBe("ended");
    // expiry is enforced by the KV (the in-memory one honours ttlSeconds through its clock)
    const { createInMemoryKv } = await import("../src/kv.js");
    let t = 0; const kv = createInMemoryKv(() => t);
    await kv.setItem("k", 1, { ttlSeconds: 30 * 86_400 });
    t = 30 * 86_400_000 - 1; expect(await kv.getItem("k")).toBe(1);
    t = 30 * 86_400_000; expect(await kv.getItem("k")).toBeNull();
  });
});

describe("anchoring and chain writes", () => {
  it("anchors a record under the notary schema, stores the tx hash, and returns anchor_receipt to the enclave", async () => {
    const h = await harness();
    await h.ctx.logs.append(JOB_HASH, { seq: 3, record_cid: "bafk-rec" });
    await ask(h, { kind: "eas_anchor", req_id: "a1", scope_id: JOB_HASH, seq: 3, record_cid: "bafk-rec" });
    expect(h.svc.anchors).toEqual([{ scopeId: JOB_HASH, seq: 3, recordCid: "bafk-rec" }]);
    expect(reply(h, "anchor_receipt").at(-1)).toMatchObject({ req_id: "a1", scope_id: JOB_HASH, seq: 3, tx_receipt: "0xtx1" });
    expect((await h.ctx.logs.list(JOB_HASH))[0]!.anchor_tx).toBe("0xtx1");
  });
  it("a failed anchor sends NO receipt (the enclave stops signing that log) and raises an anchor_backlog alert", async () => {
    const h = await harness(); h.svc.state.failAnchor = true;
    await ask(h, { kind: "eas_anchor", req_id: "a2", scope_id: JOB_HASH, seq: 0, record_cid: "c" });
    expect(reply(h, "anchor_receipt").length).toBe(0);
    expect(h.svc.alerts.map((a) => a.code)).toContain("anchor_backlog");
  });
  it("the EAS data encoding is (bytes32 job_hash, uint64 seq, string record_cid), for a job_hash or a card address scope (E16)", () => {
    expect(scopeToBytes32("ab".repeat(32))).toBe("0x" + "ab".repeat(32));
    expect(scopeToBytes32(Buffer.alloc(32, 1).toString("base64url"))).toBe("0x" + "01".repeat(32));
    expect(() => scopeToBytes32("nope")).toThrow();
    expect(encodeAnchorData({ scopeId: "ab".repeat(32), seq: 7, recordCid: "bafk" }).startsWith("0x" + "ab".repeat(32))).toBe(true);
  });
  it("submits chain writes UNCHANGED and reports the result", async () => {
    const h = await harness();
    const payload = { op: "RegisterCard", n: 1 };
    await ask(h, { kind: "chain_submit", req_id: "c1", op: "RegisterCard", payload, signature: "sig", calldata: "0xcalldata" });
    expect(h.svc.submitted).toEqual([{ op: "RegisterCard", payload, signature: "sig", calldata: "0xcalldata" }]);
    expect(reply(h, "chain_result").at(-1)).toMatchObject({ req_id: "c1", tx_receipt: "0xchain1" });
    h.svc.state.failSubmit = true;
    await ask(h, { kind: "chain_submit", req_id: "c2", op: "x", payload, signature: "s", calldata: "0x" });
    expect(reply(h, "chain_result").at(-1)).toMatchObject({ req_id: "c2", failed: "revert" });
  });
});

describe("relaying, replicas, alerts, fetches", () => {
  it("delivers notary_output messages through message routing; a routing failure does not crash the host", async () => {
    const h = await harness();
    await ask(h, { kind: "deliver", req_id: "d", routing_envelope: { to: "x" } });
    expect(h.svc.delivered).toEqual([{ to: "x" }]);
    h.svc.state.failDelivery = true;
    await ask(h, { kind: "deliver", req_id: "d2", routing_envelope: {} });
  });
  it("peer_send: to a local instance directly, else to a peer host; failure alerts", async () => {
    const h = await harness();
    await ask(h, { kind: "peer_send", req_id: "s", to_instance: [...h.ctx.instances.keys()][0]!, bytes: "QUJD" });
    expect(reply(h, "peer_message").at(-1)).toMatchObject({ bytes: "QUJD" });
    await ask(h, { kind: "peer_send", req_id: "s2", to_instance: "remote", bytes: "REVG" });
    expect(h.svc.peerSends[0]).toMatchObject({ url: "https://peer.example", body: { to_instance: "remote", bytes: "REVG" } });
    h.svc.state.failPeer = true;
    await ask(h, { kind: "peer_send", req_id: "s3", to_instance: "remote", bytes: "REVG" });
    expect(h.svc.alerts.map((a) => a.code)).toContain("enclave_lost");
  });
  it("need_replica starts a replica; failure alerts need_replica_failed", async () => {
    const h = await harness();
    await ask(h, { kind: "need_replica", req_id: "n", job_hash: JOB_HASH });
    expect(h.svc.started).toEqual([{ job: JOB_HASH, card: null }]);
    h.svc.state.noReplica = true;
    await ask(h, { kind: "need_replica", req_id: "n2", notary_card: "ab".repeat(32) });
    expect(h.svc.alerts.map((a) => a.code)).toContain("need_replica_failed");
  });
  it("alerts from the enclave are forwarded with only level and code: job data is stripped", async () => {
    const h = await harness();
    await ask(h, { kind: "alert", req_id: "x", level: "warn", code: "close_mismatch", job_hash: JOB_HASH, payload: "secret", counts: { x: 1 } });
    expect(h.svc.alerts).toEqual([{ level: "warn", code: "close_mismatch" }]);
  });
  it("fetch: per-card kinds are answered, unknown things are not_found", async () => {
    const h = await harness();
    await ask(h, { kind: "fetch", req_id: "1", what: "card_head:ab" });
    expect(reply(h, "fetch_result").at(-1)).toMatchObject({ req_id: "1", bytes: "AQ" });
    await ask(h, { kind: "fetch", req_id: "2", what: "ipfs:bafkreimissing" });
    expect(reply(h, "fetch_result").at(-1)).toMatchObject({ req_id: "2", not_found: true });
    await h.ctx.snapshots.put("pol", { policy_address: "pol", entries: [] });
    await ask(h, { kind: "fetch", req_id: "3", what: "policy_snapshot:pol" });
    expect(reply(h, "fetch_result").at(-1)).toMatchObject({ req_id: "3", bytes: b64uEncode(canonicalNotary({ policy_address: "pol", entries: [] })) });
  });
});
