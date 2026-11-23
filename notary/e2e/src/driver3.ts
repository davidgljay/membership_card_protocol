/**
 * The step 6.3 three-host scenario (docker-compose.three.yml; the base for step 7.1). Three operators' hosts, each with
 * its own Redis; host C runs two enclaves. The driver plays every party but the notaries:
 *
 *   --phase setup    genesis on each host (algorithm G), countersign, cards registered, identity-log seq 0 anchored, all
 *                    three approved; host C hands its identity to its second enclave (identity-scope handoff, logged).
 *   --phase start    a vote (THREE_JOB=aggregate: an aggregate job) with replica_set A, B, C (one instance each, min_live 3): posted to all
 *                    three hosts (only A's keys it, R12); formation by handoff; three contributors submit, each receipt
 *                    acknowledged by a quorum; the driver records which of C's enclaves holds the job (the script then
 *                    stops that container).
 *   --phase finish   the leader writes `replica_lost` and C's standby enclave is handed the job (`replicated`); it
 *                    fetches the earlier ciphertexts (need_inputs); a fourth contributor submits; after `closes_at`
 *                    the notarization counts all four, is cosigned by a quorum of distinct instances, and passes
 *                    algorithm N.
 *
 * Environment: HOSTS (comma-separated URLs, A,B,C), SIM_CHAIN_URL, NOTARY_ADMIN_TOKEN, NOTARY_HOST_MLDSA44_PRIVATE_KEY,
 * STATE_FILE, CLOSE_AFTER_SECONDS.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { ml_dsa44 } from "@noble/post-quantum/ml-dsa.js";
import { simulator } from "@membership-card-protocol/notary-attestation";
import { verifyGenesis, verifyNotarization, b64uDecode, b64uEncode, canonicalNotary, cidOfBytes, withoutFields, H, GENESIS_MAX_AGE_HOLDER_MS } from "@membership-card-protocol/verifier/notary";
import { submitNotaryInputWithRetry } from "@membership-card-protocol/wallet-sdk/notary";
import { canonicalize } from "@membership-card-protocol/verifier";
import { K, IDS, POLICY_ID, PROGRAM_CID, VOTE_ID, VOTE_PROGRAM_CID, contributor, encrypt, httpChain, registerWorld, registerVote, approveNotary, signBytes, PRESS_ADDR } from "./world.ts";
import { verifiedLists, notarizationReads, ohttp } from "./reads.ts";

const env = (k: string, d?: string) => { const v = process.env[k] ?? d; if (v === undefined) throw new Error(`${k} is required`); return v; };
const HOSTS = env("HOSTS", "http://localhost:3001,http://localhost:3002,http://localhost:3003").split(",").map((h) => h.replace(/\/$/, ""));
const chain = httpChain(env("SIM_CHAIN_URL", "http://localhost:8545").replace(/\/$/, ""));
const STATE = env("STATE_FILE", "e2e-three-state.json");
const ROOT = b64uDecode(process.env["ATTESTATION_ROOT"] ?? (JSON.parse(readFileSync(new URL("../fixtures/pins.json", import.meta.url), "utf8")) as { attestation_root: string }).attestation_root);
const attestCfg = { roots: { simulator: ROOT }, allowSimulator: true };
// the job under test: a vote (default; the criteria's "killing a replica mid-vote") or the aggregate template
const VOTE = env("THREE_JOB", "vote") === "vote";
const POLICY = VOTE ? VOTE_ID : POLICY_ID, ISSUER = VOTE ? K.vote : K.policy, PROGRAM_ID = VOTE ? VOTE_PROGRAM_CID : PROGRAM_CID;
const BALLOTS = ["yes", "no", "abstain", "yes"];
const log = (...a: unknown[]) => console.log("[e2e-3]", ...a);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function check(cond: unknown, what: string): asserts cond { if (!cond) { console.error(`[e2e-3] FAILED: ${what}`); process.exit(1); } log(`ok: ${what}`); }

async function post(hostUrl: string, path: string, body: unknown, admin = false) {
  const r = await fetch(`${hostUrl}${path}`, { method: "POST", headers: { "content-type": "application/json", ...(admin ? { authorization: `Bearer ${env("NOTARY_ADMIN_TOKEN")}` } : {}) }, body: JSON.stringify(body) });
  const j = (await r.json()) as Record<string, unknown>;
  if (!r.ok) throw new Error(`${hostUrl}${path}: ${r.status} ${JSON.stringify(j)}`);
  return j;
}
const health = async (h: string) => (await (await fetch(`${h}/health`)).json()) as { status: string; instances: string[] };

let currentJob: string | undefined;
async function waitFor<T>(what: string, f: () => Promise<T | null | undefined | false>, seconds = 60): Promise<T> {
  for (let i = 0; i < seconds * 2; i++) { try { const v = await f(); if (v) return v; } catch { /* retry */ } await sleep(500); }
  if (currentJob) { try { log(`job log at the timeout: ${(await jobLog(currentJob)).map((r) => `${r.seq}:${r.kind}`).join(" ")}`); } catch { /* best effort */ } }
  throw new Error(`timed out waiting for ${what}`);
}

type Rec = { seq: number; kind: string; instance: string; body: Record<string, unknown> };
async function jobLog(scope: string): Promise<Rec[]> {
  // start from the newest record anyone has: the newest anchor, or a host's log head (records of unanchored kinds,
  // such as `replicated`, are published but never anchored)
  const anchors = await chain.get<{ seq: number; record_cid: string }[]>(`/eas/${scope}`);
  const heads = anchors.map((a) => a.record_cid);
  for (const h of HOSTS) {
    try { const s = (await (await fetch(`${h}/jobs/${scope}/status`)).json()) as { job_log_head?: string | null }; if (s.job_log_head) heads.push(s.job_log_head); } catch { /* not a job, or that host is down */ }
  }
  let best: { seq: number; cid: string } | null = null;
  for (const cid of heads) {
    const b = await chain.bytes(cid);
    if (!b) continue;
    const r = JSON.parse(new TextDecoder().decode(b)) as Rec;
    if (best === null || r.seq > best.seq) best = { seq: r.seq, cid };
  }
  const out: Rec[] = [];
  let cid: string | undefined = best?.cid;
  while (cid) {
    const b = await chain.bytes(cid);
    if (!b) break;
    const r = JSON.parse(new TextDecoder().decode(b)) as Rec & { prev?: string };
    out.unshift(r);
    cid = r.prev;
  }
  return out;
}

interface State { cards: { card: string; kId: string; genesisAttestation: string }[]; stateCid: string; hostPub: string; jobHash?: string; closesAt?: string; killed?: string; killedInstance?: string; jobPublicKey?: string; epoch?: number }

async function setup() {
  await waitFor("sim-chain", () => chain.get("/time"));
  for (const h of HOSTS) await waitFor(`host ${h}`, async () => (await health(h)).status === "ok");
  const { policyGenesisCid } = await registerWorld(chain, 4);
  const lists = await verifiedLists(chain);
  check(lists.ok, "algorithm L accepts both governance lists");
  const hostPub = ml_dsa44.keygen(b64uDecode(env("NOTARY_HOST_MLDSA44_PRIVATE_KEY"), 32)).publicKey;
  const cards: State["cards"] = [];
  for (const [i, h] of HOSTS.entries()) {
    const request = { chain_pubkey: "", id_pubkey: "", nonce: b64uEncode(crypto.getRandomValues(new Uint8Array(16))), operator_card: K.operator.addr,
      operator_host_pubkey: b64uEncode(hostPub), platform: "simulator", policy_id: POLICY, requested_at: new Date().toISOString(), type: "notary.genesis_request.v1" };
    const g = await post(h, "/genesis", { request }, true);
    const att = b64uDecode(String(g["attestation"]));
    const attCid = cidOfBytes(att);
    const completed = g["request"] as Record<string, unknown>;
    const card = String(g["notary_card"]);
    const gr = await verifyGenesis({ request: completed as never, offer: { recipient_pubkey: String(g["id_pubkey"]), chain_pubkey: String(g["chain_pubkey"]), genesis_attestation: attCid, operator_card: K.operator.addr },
      checks: { attestationDoc: att, operatorCardValid: async (p) => !!(await chain.get(`/registry/card/${p}`)) }, cfg: attestCfg, modules: [simulator],
      acceptedRuntimes: lists.acceptedRuntimes, tEvalMs: Date.now(), nowMs: Date.now(), maxAgeMs: GENESIS_MAX_AGE_HOLDER_MS });
    check(gr.ok, `host ${"ABC"[i]}: algorithm G accepts the genesis attestation`);
    const offer: Record<string, unknown> = { chain_pubkey: g["chain_pubkey"], genesis_attestation: attCid, genesis_request: cidOfBytes(canonicalNotary(completed)), issuer_card: ISSUER.addr,
      operator_card: K.operator.addr, operator_host_pubkey: b64uEncode(hostPub), platform: "simulator", policy_id: IDS.notaryCardPolicy, recipient_pubkey: g["id_pubkey"] };
    offer["issuer_signature"] = signBytes(ISSUER, canonicalize(offer));
    const signed = (await post(h, "/genesis/countersign", { offer }, true))["offer"] as Record<string, unknown>;
    check(ml_dsa44.verify(b64uDecode(String(signed["holder_signature"])), canonicalNotary(withoutFields(signed, "holder_signature")), b64uDecode(String(g["id_pubkey"]))), `host ${"ABC"[i]}: countersigned with K_id`);
    const head = await chain.pin(encrypt(b64uDecode(String(g["id_pubkey"])), { ...signed, ancestry_pubkeys: [ISSUER.b64], issued_at: new Date().toISOString() }, `notary-card-${card}`));
    await chain.registerCard({ address: card, policy: IDS.notaryCardPolicy, press: PRESS_ADDR, head_cid: head });
    await waitFor(`identity-log seq 0 of ${card}`, async () => (await chain.get<unknown[]>(`/eas/${card}`)).length > 0);
    cards.push({ card, kId: String(g["id_pubkey"]), genesisAttestation: attCid });
  }
  const stateCid = VOTE ? await registerVote(chain, cards.map((c) => c.card)) : await approveNotary(chain, policyGenesisCid, cards.map((c) => c.card));
  // host C: its second enclave gets card C's identity (identity-scope handoff), so C can re-replicate
  const cInst = (await health(HOSTS[2]!)).instances;
  check(cInst.length === 2, "host C runs two enclaves");
  await post(HOSTS[2]!, "/operator/handoff", { scope: "identity", card: cards[2]!.card, from_instance: cInst[0], to_instance: cInst[1] }, true);
  const idLog = await waitFor("C's identity handoff record", async () => { const l = await jobLog(cards[2]!.card); return l.find((r) => r.kind === "handoff" && r.body["to_instance"] === cInst[1]) ?? null; });
  check(idLog.body["scope"] === "identity", "C's identity handoff is in its identity log, anchored");
  writeFileSync(STATE, JSON.stringify({ cards, stateCid, hostPub: b64uEncode(hostPub) } satisfies State, null, 2));
  log("setup done");
}

async function submit(st: State, i: number) {
  const { card: m, sub: s } = contributor(i);
  const blocks = await chain.get<{ number: number; hash: string }[]>("/headers?after=0");
  const ref = blocks[Math.max(0, blocks.length - 3)]!;
  const hostA = st.cards[0]!;
  return submitNotaryInputWithRetry({
    job: { jobHash: st.jobHash!, epoch: st.epoch!, jobPublicKey: st.jobPublicKey!, quorum: 2, notaryCard: hostA.card, notaryIdPubkey: hostA.kId, operatorHostPubkey: st.hostPub },
    async buildSignedInput() {
      const input = { chain_ref: { block_hash: b64uEncode(Buffer.from(ref.hash.slice(2), "hex")), block_number: ref.number }, contributor_card: m.addr, contributor_card_pubkey: m.b64,
        evidence: [], job_hash: st.jobHash!, payload: VOTE ? { choice: BALLOTS[i] } : { value: [3, 7, 12, 9][i] }, revision: 0, signed_at: new Date().toISOString(), type: "notary.input.v1" };
      return { ...input, contributor_signature: { public_key: s.b64, signature: signBytes(s, canonicalNotary(input)) } } as never;
    },
    persist: async () => {},
    async send(sealed) { const r = await ohttp(HOSTS[0]!, `/jobs/${st.jobHash}/inputs`, "POST", sealed); if (r.status !== 200) throw new Error(JSON.stringify(r.body)); return r.body as never; },
  });
}

async function start() {
  const st = JSON.parse(readFileSync(STATE, "utf8")) as State;
  const now = Date.now();
  const closeAfter = Number(env("CLOSE_AFTER_SECONDS", "330"));
  const unsigned = { closes_at: new Date(now + closeAfter * 1000).toISOString(), created_at: new Date(now).toISOString(), kem: "x-wing-draft-06", min_live: 3,
    nonce: b64uEncode(crypto.getRandomValues(new Uint8Array(16))), opens_at: new Date(now).toISOString(), parameters: VOTE ? { question: "Adopt the budget?" } : { edge_1: 5, edge_2: 10 }, policy_id: POLICY,
    output_recipient_keys: VOTE ? {} : { [contributor(0).card.addr]: contributor(0).card.b64 }, policy_state_cid: st.stateCid,
    replica_set: st.cards.map((c) => ({ instances: 1, notary_card: c.card })), requester_card: K.requester.addr, requester_pubkey: K.requester.b64, type: "notary.job.v1" };
  const job = { ...unsigned, requester_signature: { public_key: K.requester.b64, signature: signBytes(K.requester, canonicalNotary(unsigned)) } };
  const jobHash = H(job);
  currentJob = jobHash;
  // the requester sends the job to every operator's host; only the host serving replica_set[0] keys it (R12)
  check((await post(HOSTS[2]!, "/jobs", { job, program_cid: PROGRAM_ID }))["status"] === "awaiting_handoff", "host C records the job and waits for the handoff");
  check((await post(HOSTS[1]!, "/jobs", { job, program_cid: PROGRAM_ID }))["status"] === "awaiting_handoff", "host B records the job and waits for the handoff");
  check((await post(HOSTS[0]!, "/jobs", { job, program_cid: PROGRAM_ID }))["status"] === "keyed", "host A keys the job");
  const ann = await waitFor("the announcement after formation", async () => { const r = await ohttp(HOSTS[0]!, `/jobs/${jobHash}/announcement`, "GET"); return r.status === 200 ? r.body : null; }, 90) as { job_public_key: string; epoch: number; attestations: string[] };
  // the announcement is signed once a quorum is live; the last receiver's handoff record may land a moment later
  const log0 = await waitFor("a handoff record per receiver", async () => { const l = await jobLog(jobHash); return l.filter((r) => r.kind === "handoff").length >= 2 ? l : null; }, 30).catch(async () => jobLog(jobHash));
  check(log0[0]?.kind === "opened" && log0.filter((r) => r.kind === "handoff").length === 2, `formation: opened, then a handoff record per receiver (${log0.map((r) => r.kind).join(",")})`);
  check(ann.attestations.length >= 2, `the announcement lists the attestations of the replicas live when it was signed, at least q (${ann.attestations.length})`);
  for (const h of HOSTS.slice(1)) check(await waitFor(`the announcement at ${h}`, async () => { const r = await ohttp(h, `/jobs/${jobHash}/announcement`, "GET"); return r.status === 200; }), `${h} serves the relayed announcement`);
  Object.assign(st, { jobHash, closesAt: unsigned.closes_at, jobPublicKey: ann.job_public_key, epoch: ann.epoch });
  for (const i of [0, 1, 2]) {
    const r = await submit(st, i);
    check(r.submitted, `contributor ${i}: a host receipt and a validation receipt acknowledged by a quorum${r.submitted ? "" : ` (${(r as { code: string }).code}: ${(r as { reason: string }).reason})`}`);
  }
  // which of C's enclaves holds the job: the one the handoff record names (host C lists its enclaves in endpoint order)
  const holder = String(log0.find((r) => r.kind === "handoff" && r.body["to_notary_card"] === st.cards[2]!.card)!.body["to_instance"]);
  const cInst = (await health(HOSTS[2]!)).instances;
  st.killed = holder === cInst[0] ? "enclave-c1" : "enclave-c2";
  st.killedInstance = holder;
  writeFileSync(STATE, JSON.stringify(st, null, 2));
  log(`stop ${st.killed} (${holder})`);
  console.log(`KILL=${st.killed}`);
}

async function finish() {
  const st = JSON.parse(readFileSync(STATE, "utf8")) as State;
  const jobHash = st.jobHash!;
  currentJob = jobHash;
  // liveness window (120 s), then replica_lost, then the standby gets the job
  const lost = await waitFor("replica_lost", async () => (await jobLog(jobHash)).find((r) => r.kind === "replica_lost") ?? null, 240);
  check(lost.body["instance"] === st.killedInstance, "the leader wrote replica_lost for the stopped replica");
  const replicated = await waitFor("replicated", async () => (await jobLog(jobHash)).find((r) => r.kind === "replicated") ?? null, 120);
  const cInst = (await health(HOSTS[2]!)).instances;
  check(cInst.includes(String(replicated.body["instance"])) && replicated.body["instance"] !== st.killedInstance, "C's standby enclave was handed the job (handoff, then replicated)");
  await sleep(5000);
  const r = await submit(st, 3);
  check(r.submitted, "a fourth contributor's input is acknowledged by a quorum after re-replication");
  log(`waiting for close at ${st.closesAt}`);
  const notarizationCid = await waitFor("the notarized record", async () => (await jobLog(jobHash)).find((x) => x.kind === "notarized")?.body["notarization"] as string | undefined, Math.max(60, (Date.parse(st.closesAt!) - Date.now()) / 1000 + 180));
  const n = JSON.parse(new TextDecoder().decode((await chain.bytes(notarizationCid))!)) as { output: { public?: unknown }; accepted: number; close_quorum: number; dropped_after_acceptance: number; cosignatures: { instance_signature: { public_key: string } }[] };
  check(n.accepted === 4 && n.dropped_after_acceptance === 0, `the notarization counts all four contributors, none dropped (accepted=${n.accepted})`);
  if (VOTE) check(JSON.stringify(n.output.public) === JSON.stringify({ abstain: 1, no: 1, yes: 2 }), `no ballot was lost with the replica: the tally is ${JSON.stringify(n.output.public)}`);
  check(n.close_quorum === 2 && new Set(n.cosignatures.map((c) => c.instance_signature.public_key)).size >= 2, "cosigned by a quorum of distinct instances");
  const lists = await verifiedLists(chain);
  const res = await verifyNotarization(notarizationCid, notarizationReads(chain, st.cards, lists, { modules: [simulator], roots: attestCfg.roots }), { attest: attestCfg, modules: [simulator], acceptedRuntimes: lists.acceptedRuntimes });
  check(res.valid, `algorithm N verifies the notarization${res.valid ? ` (warnings: ${(res as { warnings: string[] }).warnings.join(",") || "none"})` : ` (${JSON.stringify(res)})`}`);
  check(res.valid && !(res as { warnings: string[] }).warnings.includes("NOTARIZATION_REPLICA_OVER_CAPACITY"), "no card ran more instances than replica_set allows (Q7)");
  log("THREE HOSTS: PASS");
}

const phase = process.argv[process.argv.indexOf("--phase") + 1];
if (phase === "setup") await setup();
else if (phase === "start") await start();
else if (phase === "finish") await finish();
else { console.error("usage: driver3.ts --phase setup|start|finish"); process.exit(2); }
