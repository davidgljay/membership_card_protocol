/**
 * Phase 7.2, tranche 2: attacks a hostile operator can make, against the real enclave. Each test names the attack, what
 * the spec says should happen (the clause), and checks it; the honest run is the control. Run with `run-hostile.sh`.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { simulator } from "@membership-card-protocol/notary-attestation";
import { verifyNotarization, b64uEncode, b64uDecode, canonicalNotary, H } from "@membership-card-protocol/verifier/notary";
import { checkInclusion, sealInput } from "@membership-card-protocol/wallet-sdk/notary";
import { handleCreateJob, handleGetAnnouncement, handleRestartJob } from "../../host/src/handlers/jobs.js";
import { handleOperatorHandoff } from "../../host/src/handlers/replication.js";
import { readFileSync, writeFileSync } from "node:fs";
import { createDecipheriv } from "node:crypto";
import { requestDerivedCard } from "@membership-card-protocol/wallet-sdk/notary";
import { handleOperatorSeedTemplate } from "../../host/src/handlers/replication.js";
import { handleSubmitInput } from "../../host/src/handlers/inputs.js";
import { K, POLICY_ID, PROGRAM_CID, ADV_MODULE, IDS, PRESS_ADDR, TEMPLATE_ID, DERIVE_PROGRAM_CID, contentKey, contributor, registerWorld, registerTemplate, approveNotary, signBytes, encrypt } from "../src/world.ts";
import { verifiedLists, notarizationReads } from "../src/reads.ts";
import { chain, startHost, genesisFor, waitFor, sleep, notarizationOf, attestCfg, SIM, forkedFeed, TOKEN } from "./harness.ts";
import type { Host, NotaryInfo } from "./harness.ts";
import { LEAK_ID, LEAK_KEY, LEAK_PROGRAM_CID, registerLeaky } from "./leaky.ts";

const BROKER_A = process.env["BROKER_A"] ?? "127.0.0.1:7311";
const BROKER_X = process.env["BROKER_X"] ?? "127.0.0.1:7381";
const BROKER_RX = process.env["BROKER_RX"] ?? "127.0.0.1:7401";
const BROKER_RY = process.env["BROKER_RY"] ?? "127.0.0.1:7411";
const BROKER_Y = process.env["BROKER_Y"] ?? "127.0.0.1:7391";
const BROKER_B = process.env["BROKER_B"] ?? "127.0.0.1:7321";
const BROKER_LEAK_1 = process.env["BROKER_LEAK_1"] ?? "127.0.0.1:7351";
const BROKER_LEAK_2 = process.env["BROKER_LEAK_2"] ?? "127.0.0.1:7361";
const BROKER_LEAK_3 = process.env["BROKER_LEAK_3"] ?? "127.0.0.1:7371";
const BROKER_DEBUG = process.env["BROKER_DEBUG"] ?? "127.0.0.1:7331";
const BROKER_ROGUE_PCR0 = process.env["BROKER_ROGUE_PCR0"] ?? "127.0.0.1:7341";
const ATT = { modules: [simulator], roots: attestCfg.roots };

let lists: Awaited<ReturnType<typeof verifiedLists>>;
let policyGenesisCid: string;
let hostA: Host;
let nA: NotaryInfo;
let stateCid: string;
// the policy card's log: the genesis, then one field update per approval (each names every predecessor in its history)
let policyLog: string[] = [];
let approvedCards: string[] = [];
/** The policy holder approves one more notary card; returns the state CID. */
async function approve(card: string): Promise<string> {
  approvedCards = [...approvedCards, card];
  const entry = { card_state: { approved_notaries: approvedCards }, code: 300, entry_type: "field_update", history: policyLog, prev_log_root: policyLog.at(-1), version: policyLog.length - 1 };
  const head = await chain.pin(encrypt(K.policy.pub, entry, `policy-approve-${approvedCards.length}`));
  await chain.registerCard({ address: K.policy.addr, policy: IDS.metaPolicy, press: PRESS_ADDR, head_cid: head });
  policyLog = [...policyLog, head];
  return head;
}

// the simulated chain's time leads the wall clock (each block it mines is at least a second after the last), so a job's window is set from the chain's time
const chainNow = async () => { const b = await chain.get<{ timestamp: number }[]>("/headers?after=0"); return b[b.length - 1]!.timestamp * 1000; };
let chainLead = 0;
const signedJob = (closeAfterMs: number, o: Record<string, unknown> = {}) => {
  const now = Date.now() + chainLead;
  const u = { closes_at: new Date(now + closeAfterMs).toISOString(), created_at: new Date(now - 60_000).toISOString(), kem: "x-wing-draft-06", min_live: 1, nonce: b64uEncode(crypto.getRandomValues(new Uint8Array(16))),
    opens_at: new Date(now - 60_000).toISOString(), parameters: { edge_1: 5, edge_2: 10 }, policy_id: POLICY_ID, output_recipient_keys: { [contributor(0).card.addr]: contributor(0).card.b64 },
    policy_state_cid: stateCid, replica_set: [{ instances: 1, notary_card: nA.card }], requester_card: K.requester.addr, requester_pubkey: K.requester.b64, type: "notary.job.v1", ...o };
  return { ...u, requester_signature: { public_key: K.requester.b64, signature: signBytes(K.requester, canonicalNotary(u)) } };
};

/** One contributor's input, sealed to the job's key and posted through the host's real handler. */
async function contribute(host: Host, jobHash: string, ann: { job_public_key: string; epoch: number }, i: number, value: number, ref: { number: number; hash: string }) {
  const { card: m, sub: s } = contributor(i);
  const base = { chain_ref: { block_hash: b64uEncode(Buffer.from(ref.hash.slice(2), "hex")), block_number: ref.number }, contributor_card: m.addr, contributor_card_pubkey: m.b64, evidence: [],
    job_hash: jobHash, payload: { value }, revision: 0, signed_at: new Date().toISOString(), type: "notary.input.v1" };
  const input = { ...base, contributor_signature: { public_key: s.b64, signature: signBytes(s, canonicalNotary(base)) } };
  const sealed = await sealInput({ plaintext: input as never, jobPublicKey: ann.job_public_key, epoch: ann.epoch });
  const r = await handleSubmitInput(host.ctx, jobHash, sealed.sealed);
  return { inputHash: sealed.inputHash, receipt: sealed.openReceipt(r.receipt_sealed) };
}

const recentBlock = async () => { const b = await chain.get<{ number: number; hash: string }[]>("/headers?after=0"); return b[Math.max(0, b.length - 8)]!; };

beforeAll(async () => {
  await waitFor("the simulated chain", () => chain.get("/time"));
  ({ policyGenesisCid } = await registerWorld(chain, 6));
  lists = await verifiedLists(chain);
  hostA = await startHost(BROKER_A);
  nA = await genesisFor(hostA, { lists, policyDocId: POLICY_ID, issuer: K.policy });
  stateCid = await approveNotary(chain, policyGenesisCid, nA.card);
  policyLog = [policyGenesisCid, stateCid];
  approvedCards = [nA.card];
  chainLead = Math.max(0, (await chainNow()) - Date.now());
});
afterAll(() => { hostA?.stop(); });

describe("a hostile host against the enclave", () => {
  it("control: an honest job through this host opens and its announcement verifies", async () => {
    const job = signedJob(3_600_000);
    const created = await handleCreateJob(hostA.ctx, { job, program_cid: PROGRAM_CID });
    expect(created.job_hash).toBe(H(job));
    const ann = await waitFor("the announcement", async () => { try { return await handleGetAnnouncement(hostA.ctx, H(job)); } catch { return null; } }) as { epoch: number };
    expect(ann.epoch).toBe(0);
  });

  it("the enclave itself refuses a program that is not the policy's, when the host skips its own check", async () => {
    // the host's `program_cid` check is a courtesy; a hostile host sends the enclave a different program (an audited
    // template that is simply not this policy's) in `create_job` directly
    const job = signedJob(3_600_000);
    const reply = await hostA.session.call("create_job", { job, program: b64uEncode(ADV_MODULE), transport: { key_config_url: "http://127.0.0.1:0/ohttp/key-config", relay_target_id: "hostile" } }).catch((e: Error) => ({ kind: "error", code: e.message }));
    console.log("[program mismatch at the enclave]", JSON.stringify(reply).slice(0, 200));
    expect(reply).toMatchObject({ kind: "job_rejected", code: "ADM_HASH_MISMATCH" });
  });

  it("dropped inputs: an input the enclave acknowledged but the host leaves out of the close is counted as dropped, and the contributor can tell", async () => {
    // notary_lifecycle: the validation receipt proves the enclave accepted the input; the notarization states how many it
    // accepted and how many came back at close (`dropped_after_acceptance`), and `counted_inputs` lists the ones counted
    const job = signedJob(9_000);
    const jobHash = H(job);
    await handleCreateJob(hostA.ctx, { job, program_cid: PROGRAM_CID }).catch((e: { code?: string; message: string }) => { throw new Error(`create_job: ${e.code} ${e.message}`); });
    const ann = await waitFor("the announcement", async () => { try { return await handleGetAnnouncement(hostA.ctx, jobHash); } catch { return null; } }) as { job_public_key: string; epoch: number };
    const ref = await recentBlock();
    const sent = [] as { inputHash: string; status?: string }[];
    for (const [i, v] of [[0, 3], [1, 7], [2, 12]] as const) {
      const r = await contribute(hostA, jobHash, ann, i, v, ref);
      sent.push({ inputHash: r.inputHash, status: r.receipt?.status });
    }
    expect(sent.map((x) => x.status)).toEqual(["accepted", "accepted", "accepted"]);
    // the hostile operator now deletes contributor 1's stored ciphertext
    const victim = sent[1]!.inputHash;
    const list = hostA.ctx.inputs.list.bind(hostA.ctx.inputs);
    hostA.ctx.inputs.list = async (j: string, e?: number) => (await list(j, e)).filter((k) => !k.endsWith(`:${victim}`));
    const cid = await waitFor("the notarized record", () => notarizationOf(jobHash), 90);
    hostA.ctx.inputs.list = list;
    const nz = JSON.parse(new TextDecoder().decode((await chain.bytes(cid))!)) as Record<string, unknown> & { counted_inputs: string; input_commitment: string };
    console.log("[dropped input] accepted", nz["accepted"], "dropped_after_acceptance", nz["dropped_after_acceptance"], "suppressed", nz["suppressed"]);
    const counted = JSON.parse(new TextDecoder().decode((await chain.bytes(nz.counted_inputs))!)) as string[];
    // the dropped contributor's own check: its input is not among the counted ones
    expect(checkInclusion(victim, counted, nz.input_commitment)).toMatchObject({ included: false, reason: "NOT_COUNTED" });
    // the others are
    expect(checkInclusion(sent[0]!.inputHash, counted, nz.input_commitment)).toEqual({ included: true });
    expect(checkInclusion(sent[2]!.inputHash, counted, nz.input_commitment)).toEqual({ included: true });
    expect(nz["dropped_after_acceptance"]).toBe(1);
    const notary = { card: nA.card, kId: nA.kId, genesisAttestation: nA.genesisAttestation };
    const res = await verifyNotarization(cid, notarizationReads(chain, notary, lists, ATT), { attest: attestCfg, modules: [simulator], acceptedRuntimes: lists.acceptedRuntimes });
    console.log("[dropped input] algorithm N:", JSON.stringify(res).slice(0, 220));
  });
});

describe("a hostile host feeding the enclave a chain the real one never had", () => {
  it("is detected: the notarization names a block the real chain does not have (limit L4: chain time is advisory, verifiers check chain_state)", async () => {
    // runtime §13: the enclave checks header hash linkage only, so a host can choose which chain it follows; the notarization
    // records `chain_state`, and algorithm N checks it against the real chain (NOT_CHAIN_MISMATCH)
    const fork = forkedFeed();
    const hostB = await startHost(BROKER_B, { feed: fork.wrap });
    try {
      const nB = await genesisFor(hostB, { lists, policyDocId: POLICY_ID, issuer: K.policy });
      const state2 = await approve(nB.card);
      const job = signedJob(10_000, { policy_state_cid: state2, replica_set: [{ instances: 1, notary_card: nB.card }] });
      const jobHash = H(job);
      await waitFor("forged headers", async () => fork.blocks.size > 12);
      await sleep(2000); // the host streams them to the enclave about once a second
      await handleCreateJob(hostB.ctx, { job, program_cid: PROGRAM_CID }).catch((e: { code?: string; message: string }) => { throw new Error(`create_job: ${e.code} ${e.message}`); });
      const ann = await waitFor("the announcement", async () => { try { return await handleGetAnnouncement(hostB.ctx, jobHash); } catch { return null; } }) as { job_public_key: string; epoch: number };
      // an honest wallet names a block of the REAL chain: the enclave on the fork does not know it
      const real = await recentBlock();
      const honest = await contribute(hostB, jobHash, ann, 0, 3, real);
      console.log("[forked chain] an honest wallet's input:", honest.receipt?.status, honest.receipt?.reject_reason);
      expect(honest.receipt?.status).toBe("rejected");
      expect(String(honest.receipt?.reject_reason)).toMatch(/INPUT_CHAIN_REF/);
      // a colluding contributor names a block of the fork
      const forged = [...fork.blocks.values()].at(-8)!;
      const sent = [] as (string | undefined)[];
      for (const [i, v] of [[0, 3], [1, 7], [2, 12]] as const) sent.push((await contribute(hostB, jobHash, ann, i, v, { number: forged.number, hash: forged.hash })).receipt?.status);
      expect(sent).toEqual(["accepted", "accepted", "accepted"]);
      const cid = await waitFor("the notarized record", () => notarizationOf(jobHash), 90);
      const nz = JSON.parse(new TextDecoder().decode((await chain.bytes(cid))!)) as { chain_state: { block_number: number; block_hash: string } };
      console.log("[forked chain] chain_state", JSON.stringify(nz.chain_state).slice(0, 120));
      const notary = { card: nB.card, kId: nB.kId, genesisAttestation: nB.genesisAttestation };
      const res = await verifyNotarization(cid, notarizationReads(chain, notary, lists, ATT), { attest: attestCfg, modules: [simulator], acceptedRuntimes: lists.acceptedRuntimes });
      console.log("[forked chain] algorithm N:", JSON.stringify(res).slice(0, 200));
      expect(res.valid).toBe(false);
      expect((res as { code: string }).code).toBe("NOT_CHAIN_MISMATCH");
    } finally { hostB.stop(); }
  });
});

describe("an operator running an enclave the governance list does not accept", () => {
  // notary_lifecycle Phase 0, step 5: the policy holder runs algorithm G on the genesis attestation and refuses to issue the card
  // if the runtime is not accepted or the document is in debug mode. Control: the honest enclave's genesis passed in `beforeAll`.
  it("a debug-mode enclave gets no notary card (ATT_DEBUG_MODE)", async () => {
    const rogue = await startHost(BROKER_DEBUG);
    try { await expect(genesisFor(rogue, { lists, policyDocId: POLICY_ID, issuer: K.policy })).rejects.toThrow(/ATT_DEBUG_MODE/); } finally { rogue.stop(); }
  });
  it("an enclave whose PCR0 is not on the list gets no notary card (ATT_RUNTIME_NOT_ACCEPTED)", async () => {
    const rogue = await startHost(BROKER_ROGUE_PCR0);
    try { await expect(genesisFor(rogue, { lists, policyDocId: POLICY_ID, issuer: K.policy })).rejects.toThrow(/ATT_RUNTIME_NOT_ACCEPTED/); } finally { rogue.stop(); }
  });
});

describe("a deliberately leaky program", () => {
  // runtime §11: whatever a program writes, the runtime applies the policy's output schema before anything is released:
  // declared fields only, clamped, rounded to `round_to`. The three jobs run the same program with the same inputs; only the
  // program's `mode` differs.
  const recordKinds = async (jobHash: string) => {
    const out: string[] = [];
    for (const rc of await chain.get<{ seq: number; record_cid: string }[]>(`/eas/${jobHash}`)) {
      const b = await chain.bytes(rc.record_cid);
      if (b) out.push((JSON.parse(new TextDecoder().decode(b)) as { kind: string }).kind);
    }
    return out;
  };
  async function runLeaky(mode: string, values: number[]) {
    const { host: hostL, notary: nL } = leak[mode]!;
    chainLead = Math.max(0, (await chainNow()) - Date.now()); // the simulated chain's lead over the wall clock grows with every block it mines
    const job = signedJob(14_000, { policy_id: LEAK_ID, policy_state_cid: leakState, replica_set: [{ instances: 1, notary_card: nL.card }], parameters: { mode }, output_recipient_keys: {} });
    const jobHash = H(job);
    await handleCreateJob(hostL.ctx, { job, program_cid: LEAK_PROGRAM_CID }).catch((e: { code?: string; message: string }) => { throw new Error(`create_job(${mode}): ${e.code} ${e.message}`); });
    const ann = await waitFor("the announcement", async () => { try { return await handleGetAnnouncement(hostL.ctx, jobHash); } catch { return null; } }) as { job_public_key: string; epoch: number };
    const ref = await recentBlock();
    for (const [i, v] of values.entries()) expect((await contribute(hostL, jobHash, ann, i, v, ref)).receipt?.status).toBe("accepted");
    return { jobHash };
  }
  // `dedicated` isolation: an enclave runs one such job at a time, so each leaky job gets an enclave of its own
  const leak: Record<string, { host: Host; notary: NotaryInfo }> = {};
  let leakState: string;
  beforeAll(async () => {
    for (const [mode, broker] of [["honest", BROKER_LEAK_1], ["exact", BROKER_LEAK_2], ["exfiltrate", BROKER_LEAK_3]] as const) {
      const host = await startHost(broker);
      leak[mode] = { host, notary: await genesisFor(host, { lists, policyDocId: LEAK_ID, issuer: LEAK_KEY as never }) };
    }
    leakState = await registerLeaky(chain, Object.values(leak).map((x) => x.notary.card));
  });
  afterAll(() => { for (const x of Object.values(leak)) x.host.stop(); });

  it("control: an honest program's result is released, coarsened to the schema's rounding", async () => {
    const { jobHash } = await runLeaky("honest", [3, 4, 5]);
    const cid = await waitFor("the notarized record", () => notarizationOf(jobHash), 90);
    const nz = JSON.parse(new TextDecoder().decode((await chain.bytes(cid))!)) as { output: { public: Record<string, unknown> }; suppressed: boolean };
    console.log("[leaky: honest]", JSON.stringify(nz.output));
    expect(nz.output.public).toEqual({ score: 10 }); // 3 + 4 + 5 = 12, rounded to the nearest 10
  });

  it("a program that writes a contributor's exact value is released only as the schema allows (rounded to 10)", async () => {
    const { jobHash } = await runLeaky("exact", [37, 37, 37]);
    const cid = await waitFor("the notarized record", () => notarizationOf(jobHash), 90);
    const nz = JSON.parse(new TextDecoder().decode((await chain.bytes(cid))!)) as { output: { public: Record<string, unknown> } };
    console.log("[leaky: exact]", JSON.stringify(nz.output));
    expect(nz.output.public).toEqual({ score: 40 });
    expect(JSON.stringify(nz.output)).not.toContain("37"); // the exact value is nowhere in what was released
  });

  it("a program that adds a field outside the schema gets nothing released", async () => {
    const sess = leak["exfiltrate"]!.host.session;
    const call = sess.call.bind(sess);
    const replies: string[] = [];
    sess.call = (async (kind: string, fields?: Record<string, unknown>, t?: number) => { try { const r = await call(kind, fields, t); if (kind === "close_chunk") replies.push(`${r.kind} ${JSON.stringify(r).slice(0, 160)}`); return r; } catch (e) { if (kind === "close_chunk") replies.push(`threw ${(e as Error).message}`); throw e; } }) as typeof sess.call;
    const { jobHash } = await runLeaky("exfiltrate", [37, 37, 37]);
    // the simulated chain's time leads the wall clock, and close needs both: wait until the host's first real attempt (not CLOSE_NOT_DUE)
    await waitFor("the close attempt", async () => replies.some((r) => !r.includes("CLOSE_NOT_DUE")), 180);
    await sleep(3_000);
    console.log("[leaky: exfiltrate] close replies:", replies.filter((r) => !r.includes("CLOSE_NOT_DUE")).slice(0, 2).join(" | "));
    const kinds = await recordKinds(jobHash);
    const cid = await notarizationOf(jobHash);
    console.log("[leaky: exfiltrate] job log kinds:", kinds.join(","), "notarized:", cid ? "yes" : "no");
    console.log("[leaky: exfiltrate] the operator's alerts:", [...new Set(leak["exfiltrate"]!.host.alerts.map((a) => a.code))].join(","));
    expect(cid).toBeNull();
    expect(kinds).not.toContain("notarized");
    expect(leak["exfiltrate"]!.host.alerts.map((a) => a.code)).toContain("close_failed");
  });
});

describe("killing every process that holds a job's key", () => {
  // notary_replication §7: when no replica holds the job key, the operator starts the next epoch and the wallets resubmit
  // their stored inputs. Here the enclave holding the job is killed (SIGKILL, process and attestation service), and the
  // notary identity survives in a second enclave (an identity handoff before the job started).
  const pid = (n: string) => Number(readFileSync(`${process.env["PIDDIR"]}/pid-${n}`, "utf8"));
  const records = async (scope: string) => {
    const out: { kind: string; body: Record<string, unknown> }[] = [];
    for (const rc of await chain.get<{ record_cid: string }[]>(`/eas/${scope}`)) { const b = await chain.bytes(rc.record_cid); if (b) out.push(JSON.parse(new TextDecoder().decode(b))); }
    return out;
  };
  it("the job is restarted from the surviving identity holder, and the tally is of the resubmitted inputs", async () => {
    const hostK = await startHost([BROKER_X, BROKER_Y]);
    try {
      const [ix, iy] = hostK.instances as [string, string];
      const nK = await genesisFor(hostK, { lists, policyDocId: POLICY_ID, issuer: K.policy }); // on enclave X
      const stateK = await approve(nK.card);
      await handleOperatorHandoff(hostK.ctx, `Bearer ${TOKEN}`, { scope: "identity", card: nK.card, from_instance: ix, to_instance: iy });
      await waitFor("the identity handoff record", async () => (await records(nK.card)).some((r) => r.kind === "handoff" && r.body["to_instance"] === iy), 60);
      chainLead = Math.max(0, (await chainNow()) - Date.now());
      const job = signedJob(45_000, { policy_state_cid: stateK, replica_set: [{ instances: 1, notary_card: nK.card }] });
      const jobHash = H(job);
      await handleCreateJob(hostK.ctx, { job, program_cid: PROGRAM_CID }).catch((e: { code?: string; message: string }) => { throw new Error(`create_job: ${e.code} ${e.message}`); });
      const ann0 = await waitFor("the announcement", async () => { try { return await handleGetAnnouncement(hostK.ctx, jobHash); } catch { return null; } }) as { job_public_key: string; epoch: number };
      const ref0 = await recentBlock();
      for (const [i, v] of [[0, 3], [1, 7], [2, 12]] as const) expect((await contribute(hostK, jobHash, ann0, i, v, ref0)).receipt?.status).toBe("accepted");
      // every process that held the job key dies
      process.kill(pid("x-broker"), "SIGKILL");
      process.kill(pid("x-fake"), "SIGKILL");
      await waitFor("the host to notice", async () => hostK.ctx.instances.get(ix)!.closed, 30);
      // the notary identity lives on in Y; nothing there holds the job
      const restarted = await handleRestartJob(hostK.ctx, `Bearer ${TOKEN}`, jobHash, { reason: "total_loss" });
      expect(restarted.epoch).toBe(1);
      const ann1 = await waitFor("the epoch-1 announcement", async () => { try { const a = await handleGetAnnouncement(hostK.ctx, jobHash) as { epoch: number }; return a.epoch === 1 ? a : null; } catch { return null; } }, 60) as { job_public_key: string; epoch: number };
      expect(ann1.job_public_key).not.toBe(ann0.job_public_key);
      const ref1 = await recentBlock();
      for (const [i, v] of [[0, 3], [1, 7], [2, 12]] as const) expect((await contribute(hostK, jobHash, ann1, i, v, ref1)).receipt?.status).toBe("accepted");
      const cid = await waitFor("the notarized record", () => notarizationOf(jobHash), 180);
      const nz = JSON.parse(new TextDecoder().decode((await chain.bytes(cid))!)) as { accepted: number; final_epoch: number; suppressed: boolean };
      expect(nz).toMatchObject({ accepted: 3, final_epoch: 1, suppressed: false });
      const notary = { card: nK.card, kId: nK.kId, genesisAttestation: nK.genesisAttestation };
      const res = await verifyNotarization(cid, notarizationReads(chain, notary, lists, ATT), { attest: attestCfg, modules: [simulator], acceptedRuntimes: lists.acceptedRuntimes });
      console.log("[kill every replica] algorithm N:", JSON.stringify(res).slice(0, 260));
      expect(res.valid).toBe(true);
      expect((res as { warnings: string[] }).warnings).toContain("EPOCH_TOTAL_LOSS");
    } finally { hostK.stop(); }
  });
});

describe("a host that rolls a replica back to an old state blob", () => {
  // replication §8: the sealed-link state (which derived card links to which source card) is a signed blob the holders pass
  // by heartbeat; a holder loads only a higher version and never goes back (STATE_ROLLBACK), so a host can withhold, not
  // roll back. The harm a rollback would do: after the leader dies, the survivor would not know the newer links, and a
  // source revocation of a card linked only in the newer state would never reach its derived card.
  const pid = (n: string) => Number(readFileSync(`${process.env["PIDDIR"]}/pid-${n}`, "utf8"));
  const openDoc = (pub: Uint8Array, bytes: Uint8Array): Record<string, unknown> => {
    const d = createDecipheriv("aes-256-gcm", contentKey(pub), bytes.subarray(0, 12));
    d.setAuthTag(bytes.subarray(bytes.length - 16));
    return JSON.parse(Buffer.concat([d.update(bytes.subarray(12, bytes.length - 16)), d.final()]).toString()) as Record<string, unknown>;
  };
  const records = async (scope: string) => {
    const out: { kind: string; body: Record<string, unknown> }[] = [];
    for (const rc of await chain.get<{ record_cid: string }[]>(`/eas/${scope}`)) { const b = await chain.bytes(rc.record_cid); if (b) out.push(JSON.parse(new TextDecoder().decode(b))); }
    return out;
  };

  it("the survivor still knows every link and revokes the cards of the newer state", async () => {
    const RealDate = Date;
    let warped = 0;
    const warpAll = async (ms: number) => {
      warped += ms;
      await fetch(`${SIM}/warp`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ms }) });
      for (const n of ["rx", "ry"]) writeFileSync(`${process.env["PIDDIR"]}/off-${n}`, String(warped));
    };
    // the wallets, the host and the enclaves read one moved clock
    globalThis.Date = class extends RealDate { constructor(...a: unknown[]) { if (a.length === 0) super(RealDate.now() + warped); else super(...(a as [number])); } static override now() { return RealDate.now() + warped; } } as unknown as DateConstructor;
    const hostR = await startHost([BROKER_RX, BROKER_RY]);
    try {
      const [ix, iy] = hostR.instances as [string, string];
      const auth = `Bearer ${TOKEN}`;
      const nT = await genesisFor(hostR, { lists, policyDocId: TEMPLATE_ID, issuer: K.template });
      const post = async (path: string, body: unknown) => (await fetch(`${SIM}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json();
      const stateT = await registerTemplate(chain, nT.card, nT.chainPubkey, post);
      await handleOperatorSeedTemplate(hostR.ctx, auth, { template: TEMPLATE_ID, notary_card: nT.card, nullifier_period: "P1D" });
      // the identity and the template key go to Y by handoff: Y can take over
      if (!process.env["NO_HANDOFF"]) await handleOperatorHandoff(hostR.ctx, auth, { scope: "identity", card: nT.card, from_instance: ix, to_instance: iy });
      if (!process.env["NO_HANDOFF"]) await waitFor("the identity handoff", async () => (await records(nT.card)).some((r) => r.kind === "handoff" && r.body["scope"] === "identity" && r.body["to_instance"] === iy), 60);
      if (!process.env["NO_HANDOFF"]) await handleOperatorHandoff(hostR.ctx, auth, { scope: "template", card: nT.card, template: TEMPLATE_ID, from_instance: ix, to_instance: iy });
      if (!process.env["NO_HANDOFF"]) await waitFor("the template handoff", async () => (await records(nT.card)).some((r) => r.kind === "handoff" && r.body["scope"] === "template" && r.body["to_instance"] === iy), 60);

      // a derived-card job on X
      const PERIOD = 86_400_000;
      chainLead = Math.max(0, (await chainNow()) - RealDate.now());
      const t0 = Date.now() + chainLead;
      const u = { created_at: new Date(t0 - 60_000).toISOString(), ends_at: new Date(t0 + 3 * PERIOD).toISOString(), kem: "x-wing-draft-06", key_period: "P1D", min_live: 1, nonce: b64uEncode(crypto.getRandomValues(new Uint8Array(16))),
        opens_at: new Date(t0 - 60_000).toISOString(), parameters: { projected_fields: ["member_level"], source_policy: IDS.sourcePolicy }, policy_id: TEMPLATE_ID, policy_state_cid: stateT,
        replica_set: [{ instances: 1, notary_card: nT.card }], requester_card: K.requester.addr, requester_pubkey: K.requester.b64, type: "notary.job.v1" };
      const job = { ...u, requester_signature: { public_key: K.requester.b64, signature: signBytes(K.requester, canonicalNotary(u)) } };
      const jobHash = H(job);
      await handleCreateJob(hostR.ctx, { job, program_cid: DERIVE_PROGRAM_CID }).catch((e: { code?: string; message: string }) => { throw new Error(`create_job: ${e.code} ${e.message}`); });
      const ann = await waitFor("the announcement", async () => { try { return await handleGetAnnouncement(hostR.ctx, jobHash); } catch { return null; } }) as { job_public_key: string; epoch: number };

      // what the host sees pass between the replicas (the host can record and replay any of it)
      const submits: string[] = [];
      const origSubmit = hostR.ctx.submitter.submit.bind(hostR.ctx.submitter);
      hostR.ctx.submitter.submit = async (x) => { const r = await origSubmit(x); submits.push(`${x.op}:${JSON.stringify(r).slice(0, 80)}`); return r; };
      const sessY = hostR.ctx.instances.get(iy)!;
      const toY: { req_id: string; fields: Record<string, unknown>; at: number }[] = [];
      const origNotify = sessY.notify.bind(sessY);
      let recording = false;
      sessY.notify = (async (kind: string, req_id: string, fields: Record<string, unknown> = {}) => { if (recording && kind === "peer_message") toY.push({ req_id, fields, at: Date.now() }); return origNotify(kind, req_id, fields); }) as typeof sessY.notify;

      const issue = async (holders: number[]) => {
        const period = Math.floor(Date.now() / PERIOD);
        const expiresAt = new RealDate((period + 1) * PERIOD).toISOString();
        const got: { derivedAddress: string; derivedPublicKey: string; issuedAtBoundary: string; i: number }[] = [];
        for (const i of holders) {
          const { card: m, sub: s } = contributor(i);
          let r: Awaited<ReturnType<typeof requestDerivedCard>>;
          for (let attempt = 0; ; attempt++) {
            const blocks = await chain.get<{ number: number; hash: string }[]>("/headers?after=0");
            const ref = blocks[Math.max(0, blocks.length - 8 - 3 * attempt)]!;
            r = await requestDerivedCard({
              job: { jobHash, epoch: ann.epoch, jobPublicKey: ann.job_public_key, quorum: 1, notaryCard: nT.card, notaryIdPubkey: nT.kId, operatorHostPubkey: nT.hostPub },
              consent: { template: TEMPLATE_ID, sourcePolicy: IDS.sourcePolicy, projectedFields: ["member_level"], expiresAt }, sourceFields: { member_level: "gold" }, targetPeriod: period, keys: { persistNewKey: async () => {} },
              async buildSignedInput(payload) {
                const input = { chain_ref: { block_hash: b64uEncode(Buffer.from(ref.hash.slice(2), "hex")), block_number: ref.number }, contributor_card: m.addr, contributor_card_pubkey: m.b64, evidence: [], job_hash: jobHash, payload, revision: 0, signed_at: new Date().toISOString(), type: "notary.input.v1" };
                return { ...input, contributor_signature: { public_key: s.b64, signature: signBytes(s, canonicalNotary(input)) } } as never;
              },
              persist: async () => {},
              async send(sealed) { return (await handleSubmitInput(hostR.ctx, jobHash, sealed)) as never; },
            });
            if (r.pending || (r as { code: string }).code !== "INPUT_CHAIN_REF_UNKNOWN" || attempt >= 5) break;
            await sleep(2000);
          }
          if (!r.pending) throw new Error(`holder ${i}: ${(r as { code: string }).code}: ${(r as { reason: string }).reason}`);
          got.push({ derivedAddress: r.derivedAddress, derivedPublicKey: r.derivedPublicKey, issuedAtBoundary: r.issuedAtBoundary, i });
        }
        await warpAll(Date.parse(got[0]!.issuedAtBoundary) - Date.now() + 60_000);
        for (const g of got) await waitFor(`holder ${g.i}'s card`, async () => (await fetch(`${SIM}/registry/card/${g.derivedAddress}`)).ok, 40).catch((e) => { console.log("[rollback] alerts:", JSON.stringify(hostR.alerts.slice(-6)), "warped", warped, "boundary", got[0]!.issuedAtBoundary, "now", new Date().toISOString()); throw e; });
        return got;
      };
      const batchA = await issue([0, 1, 2]); // a group releases only at min_anonymity_set (3) cards;            // state v1 (the host sees what X sends Y from here on)
      recording = true;
      for (let k = 0; k < 3; k++) { await warpAll(40_000); await sleep(3000); }
      const v1Messages = toY.length;
      console.log("[rollback] messages from X to Y recorded in the v1 era:", v1Messages);
      const batchB = await issue([3, 4, 5]);           // state v2: links the v1 state does not have
      for (let k = 0; k < 4; k++) { await warpAll(40_000); await sleep(3000); }
      // the hostile host replays what it saw in the v1 era to Y, now that Y is at v2
      if (!process.env["NO_REPLAY"]) for (const m of toY.slice(0, v1Messages)) await origNotify("peer_message", m.req_id, m.fields);
      recording = false;
      await sleep(3000);
      // X dies; Y takes over after the liveness window
      if (!process.env["NO_KILL"]) {
        process.kill(pid("rx-broker"), "SIGKILL");
        process.kill(pid("rx-fake"), "SIGKILL");
        await waitFor("the host to notice", async () => hostR.ctx.instances.get(ix)!.closed, 30);
      }
      for (let k = 0; k < 10; k++) { await warpAll(40_000); await sleep(3000); } // far past the 120 s liveness window, in ticks the enclave reads
      // two source cards linked only in v2 are revoked by a certified press
      const sourceEntry = async (i: number, code: number) => {
        const m = contributor(i).card;
        const entry: Record<string, unknown> = { card_state: {}, code, entry_type: "revocation", version: 2 };
        entry["press_signature"] = { public_key: K.srcPress.b64, signature: signBytes(K.srcPress, canonicalNotary(entry)) };
        await chain.registerCard({ address: m.addr, policy: IDS.sourcePolicy, press: PRESS_ADDR, head_cid: await chain.pin(encrypt(m.pub, entry, `rollback-source-${i}-${code}`, true)) });
      };
      const batches = async () => (await chain.get<{ op: string }[]>("/txs")).filter((t) => t.op === "batch_update_card_heads").length;
      const before = await batches();
      await sourceEntry(4, 803);
      await sourceEntry(5, 905);
      await sleep(8000);
      await warpAll(2 * 3_600_000 + 10 * 60_000);
      await waitFor("the survivor's revocation batch", async () => (await batches()) > before, 120).catch((e) => { console.log("[rollback] alerts:", JSON.stringify([...new Set(hostR.alerts.map((a) => a.code))]), "submits:", JSON.stringify(submits.slice(-6))); throw e; });
      const head = async (g: { derivedAddress: string; derivedPublicKey: string }) => { const c = await chain.get<{ head_cid: string }>(`/registry/card/${g.derivedAddress}`); return openDoc(b64uDecode(g.derivedPublicKey, 1312), (await chain.bytes(c.head_cid))!); };
      const d2 = await head(batchB[1]!), d3 = await head(batchB[2]!);
      console.log("[rollback] codes of the derived cards of the v2-only links:", d2["code"], d3["code"]);
      expect([d2["code"], d3["code"]]).toEqual([820, 920]);
      void batchA;
    } finally { hostR.stop(); globalThis.Date = RealDate; }
  });
});

void sleep; void IDS; void SIM; void notarizationOf; void verifyNotarization; void checkInclusion; void contribute; void recentBlock; void notarizationReads; void ATT;
