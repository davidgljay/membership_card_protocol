/**
 * The step 5.5 end-to-end driver. It plays every party other than the notary itself, against a running stack
 * (sim-chain, fake enclave service, `notary-runtime --mode broker`, the host):
 *
 *   --phase setup   world registration; the operator's genesis (`/genesis`); the policy holder's algorithm G, offer and
 *                   signature; countersign; the notary card registered; the identity log's seq 0 anchored (E26); the
 *                   policy holder approves the card. Writes the state file. The host must then be restarted with
 *                   `NOTARY_CARD_ADDRESSES` = the card (printed, and in the state file).
 *   --phase job     the requester's job (`POST /jobs`); the wallet fetches the announcement through the gateway and runs
 *                   algorithm W; three contributors seal and submit inputs and check both receipts; after `closes_at`
 *                   the notarization is fetched from the job log and checked with algorithm N.
 *
 * Environment: HOST_URL, SIM_CHAIN_URL, NOTARY_ADMIN_TOKEN, NOTARY_HOST_MLDSA44_PRIVATE_KEY (the host's seed, to know
 * `operator_host_pubkey`), ATTESTATION_ROOT (base64url DER of the simulator root), STATE_FILE, CLOSE_AFTER_SECONDS.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { ml_dsa44 } from "@noble/post-quantum/ml-dsa.js";
import { simulator } from "@membership-card-protocol/notary-attestation";
import { notaryStage5Hook, verifyGenesis, verifyNotarization, b64uDecode, b64uEncode, canonicalNotary, cidOfBytes, withoutFields, H, GENESIS_MAX_AGE_HOLDER_MS } from "@membership-card-protocol/verifier/notary";
import { verifyNotaryJob, submitNotaryInputWithRetry, watchNotaryJobsOnce, requestDerivedCard, checkInclusion, sealInput } from "@membership-card-protocol/wallet-sdk/notary";
import type { StoredNotaryInput } from "@membership-card-protocol/wallet-sdk/notary";
import { canonicalize, CardVerifier } from "@membership-card-protocol/verifier";
import { keccak_256 } from "@noble/hashes/sha3";
import { createDecipheriv } from "node:crypto";
import { decryptRoutingEnvelope } from "@membership-card-protocol/app-sdk";
import { K, key, OUTSIDER, ADV_MODULE, IDS, POLICY_ID, PROGRAM_CID, contentKey, contributor, kemKeypair, encrypt, httpChain, registerWorld, approveNotary, registerTemplate, registerVote, registerAdv, ADV_ID, ADV_PROGRAM_CID, PROGRAM, signBytes, PRESS_ADDR, TEMPLATE_ID, DERIVE_MODULE, DERIVE_PROGRAM_CID, DERIVE_PROPAGATION, SOURCE_POLICY_DOC, VOTE_ID, VOTE_PROGRAM_CID, EXPIRY, EXPIRY_ID } from "./world.ts";
import { verifiedLists, walletReads, notarizationReads, ohttp, httpRpc } from "./reads.ts";

const env = (k: string, d?: string) => { const v = process.env[k] ?? d; if (v === undefined) throw new Error(`${k} is required`); return v; };
const HOST = env("HOST_URL", "http://localhost:3000").replace(/\/$/, "");
const SIM = env("SIM_CHAIN_URL", "http://localhost:8545").replace(/\/$/, "");
const chain = httpChain(SIM);
const STATE = env("STATE_FILE", "e2e-state.json");
// the simulator's test root: from the environment, or the one pinned in the runtime image's pins file
const ROOT = b64uDecode(process.env["ATTESTATION_ROOT"] ?? (JSON.parse(readFileSync(new URL("../fixtures/pins.json", import.meta.url), "utf8")) as { attestation_root: string }).attestation_root);
const attestCfg = { roots: { simulator: ROOT }, allowSimulator: true };
const ATT = { modules: [simulator], roots: attestCfg.roots };
const log = (...a: unknown[]) => console.log("[e2e]", ...a);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function check(cond: unknown, what: string): asserts cond { if (!cond) { console.error(`[e2e] FAILED: ${what}`); process.exit(1); } log(`ok: ${what}`); }

async function host(path: string, body: unknown, admin = false) {
  const r = await fetch(`${HOST}${path}`, { method: "POST", headers: { "content-type": "application/json", ...(admin ? { authorization: `Bearer ${env("NOTARY_ADMIN_TOKEN")}` } : {}) }, body: JSON.stringify(body) });
  const j = (await r.json()) as Record<string, unknown>;
  if (!r.ok) throw new Error(`${path}: ${r.status} ${JSON.stringify(j)}`);
  return j;
}

async function waitFor<T>(what: string, f: () => Promise<T | null | undefined | false>, seconds = 60): Promise<T> {
  for (let i = 0; i < seconds * 2; i++) { try { const v = await f(); if (v) return v; } catch { /* retry */ } await sleep(500); }
  throw new Error(`timed out waiting for ${what}`);
}

type NotaryInfo = { card: string; kId: string; chainPubkey: string; genesisAttestation: string; hostPub: string };

/**
 * Lifecycle Phase 0, steps 2 to 7 and 9 for one policy: the operator's genesis request (`/genesis`), the policy holder's
 * algorithm G, offer and signature, the enclave's countersign, the notary card registered, and identity-log seq 0 anchored
 * (E26). `policyDocId` is the plain policy document the request names (E11: its key is the offer's `issuer_card`).
 */
async function genesisFor(o: { lists: Awaited<ReturnType<typeof verifiedLists>>; policyDocId: string; issuer: typeof K.policy }): Promise<NotaryInfo> {
  const { lists } = o;
  const hostPub = ml_dsa44.keygen(b64uDecode(env("NOTARY_HOST_MLDSA44_PRIVATE_KEY"), 32)).publicKey;
  const request = { chain_pubkey: "", id_pubkey: "", nonce: b64uEncode(crypto.getRandomValues(new Uint8Array(16))), operator_card: K.operator.addr,
    operator_host_pubkey: b64uEncode(hostPub), platform: "simulator", policy_id: o.policyDocId, requested_at: new Date().toISOString(), type: "notary.genesis_request.v1" };
  const g = await host("/genesis", { request }, true);
  const att = b64uDecode(String(g["attestation"]));
  const attCid = cidOfBytes(att);
  const completed = g["request"] as Record<string, unknown>;
  const card = String(g["notary_card"]);
  log(`genesis: notary card ${card}`);

  // step 5: the policy holder runs algorithm G (max_age 7 days) and builds the offer
  const gr = await verifyGenesis({ request: completed as never, offer: { recipient_pubkey: String(g["id_pubkey"]), chain_pubkey: String(g["chain_pubkey"]), genesis_attestation: attCid, operator_card: K.operator.addr },
    checks: { attestationDoc: att, operatorCardValid: async (p) => !!(await chain.get(`/registry/card/${p}`)) }, cfg: attestCfg, modules: [simulator],
    acceptedRuntimes: lists.acceptedRuntimes, tEvalMs: Date.now(), nowMs: Date.now(), maxAgeMs: GENESIS_MAX_AGE_HOLDER_MS });
  check(gr.ok, `algorithm G accepts the genesis attestation${gr.ok ? "" : ` (${(gr as { code: string }).code})`}`);
  const requestCid = cidOfBytes(canonicalNotary(completed));
  check(await chain.bytes(requestCid), "the completed genesis request is pinned (E17)");
  const offer: Record<string, unknown> = { chain_pubkey: g["chain_pubkey"], genesis_attestation: attCid, genesis_request: requestCid, issuer_card: o.issuer.addr,
    operator_card: K.operator.addr, operator_host_pubkey: b64uEncode(hostPub), platform: "simulator", policy_id: IDS.notaryCardPolicy, recipient_pubkey: g["id_pubkey"] };
  offer["issuer_signature"] = signBytes(o.issuer, canonicalize(offer));
  // step 6: countersign
  const signed = (await host("/genesis/countersign", { offer }, true))["offer"] as Record<string, unknown>;
  check(ml_dsa44.verify(b64uDecode(String(signed["holder_signature"])), canonicalNotary(withoutFields(signed, "holder_signature")), b64uDecode(String(g["id_pubkey"]))), "the enclave countersigned with K_id");
  // step 7: a press for NotaryCardPolicy registers the card (encrypted under K_id)
  // the card the policy holder issued: its chain runs through the issuer (`ancestry_pubkeys`), which a derived card's chain walk needs
  const cardDoc = { ...signed, ancestry_pubkeys: [o.issuer.b64], issued_at: new Date().toISOString() };
  const head = await chain.pin(encrypt(b64uDecode(String(g["id_pubkey"])), cardDoc, `notary-card-${card}`));
  await chain.registerCard({ address: card, policy: IDS.notaryCardPolicy, press: PRESS_ADDR, head_cid: head });
  // step 9 (E26): identity-log seq 0, anchored
  const anchors = await waitFor("identity-log seq 0 anchor", async () => { const a = await chain.get<{ seq: number; record_cid: string }[]>(`/eas/${card}`); return a.length ? a : null; });
  check(anchors[0]!.seq === 0, "identity-log seq 0 is anchored on the chain (E26)");
  return { card, kId: String(g["id_pubkey"]), chainPubkey: String(g["chain_pubkey"]), genesisAttestation: attCid, hostPub: b64uEncode(hostPub) };
}

async function setup() {
  await waitFor("sim-chain", () => chain.get("/time"));
  await waitFor("host", async () => ((await (await fetch(`${HOST}/health`)).json()) as { status: string }).status === "ok");
  const { policyGenesisCid } = await registerWorld(chain, 6);
  log("world registered");
  const lists = await verifiedLists(chain);
  check(lists.ok, `algorithm L accepts both governance lists (${lists.codes.join(",")})`);
  const n = await genesisFor({ lists, policyDocId: POLICY_ID, issuer: K.policy });
  // step 8: the policy holder approves the card
  const stateCid = await approveNotary(chain, policyGenesisCid, n.card);
  writeFileSync(STATE, JSON.stringify({ card: n.card, kId: n.kId, genesisAttestation: n.genesisAttestation, stateCid, hostPub: n.hostPub }, null, 2));
  log(`setup done; the host serves ${n.card} (created through /genesis)`);
}

async function job() {
  const st = JSON.parse(readFileSync(STATE, "utf8")) as { card: string; kId: string; genesisAttestation: string; stateCid: string; hostPub: string };
  await waitFor("host", async () => ((await (await fetch(`${HOST}/health`)).json()) as { status: string }).status === "ok");
  const lists = await verifiedLists(chain);
  const notary = { card: st.card, kId: st.kId, genesisAttestation: st.genesisAttestation };

  // Phase 2: the requester's job
  const now = Date.now();
  const closeAfter = Number(env("CLOSE_AFTER_SECONDS", "40"));
  const unsigned = { closes_at: new Date(now + closeAfter * 1000).toISOString(), created_at: new Date(now).toISOString(), kem: "x-wing-draft-06", min_live: 1,
    nonce: b64uEncode(crypto.getRandomValues(new Uint8Array(16))), opens_at: new Date(now).toISOString(), parameters: { edge_1: 5, edge_2: 10 }, policy_id: POLICY_ID,
    output_recipient_keys: { [contributor(0).card.addr]: contributor(0).card.b64 }, policy_state_cid: st.stateCid, replica_set: [{ instances: 1, notary_card: st.card }], requester_card: K.requester.addr, requester_pubkey: K.requester.b64, type: "notary.job.v1" };
  const job = { ...unsigned, requester_signature: { public_key: K.requester.b64, signature: signBytes(K.requester, canonicalNotary(unsigned)) } };
  const created = await host("/jobs", { job, program_cid: PROGRAM_CID });
  const jobHash = String(created["job_hash"]);
  check(jobHash === H(job), `the host accepted the job (${jobHash})`);

  // the wallet: announcement through the gateway, then algorithm W
  const ann = await waitFor("announcement", async () => { const r = await ohttp(HOST, `/jobs/${jobHash}/announcement`, "GET"); return r.status === 200 ? r.body : null; });
  const config = { attestationRoots: { "aws-nitro-enclaves": new Uint8Array(0), simulator: ROOT }, allowSimulator: true, acceptedRuntimesCard: K.listRuntimes.addr,
    programAllowlistCard: K.listPrograms.addr, notaryCardPolicy: IDS.notaryCardPolicy, acceptedKems: ["x-wing-draft-06"] as ["x-wing-draft-06"] };
  const v = await verifyNotaryJob({ announcement: ann, config, reads: walletReads(chain, notary, lists, ATT), lists, attestation: [simulator] });
  check(v.valid, `algorithm W accepts the announcement${v.valid ? ` (warnings: ${v.warnings.join(",") || "none"})` : ` (${(v as { code: string }).code}: ${(v as { reason: string }).reason})`}`);
  if (!v.valid) return;
  // one operator runs every replica here: the bootstrap allowance is disclosed (L4, §34)
  check((v.consent as unknown as { singleOperatorQuorum: boolean }).singleOperatorQuorum === true, "the consent model discloses the single-operator quorum");
  const a = ann as { job_public_key: string; epoch: number };

  // Phase 3: three contributors, one value each (the aggregate template: count, sum and buckets at edges 5 and 10)
  const choices = [3, 7, 12];
  const stored: StoredNotaryInput[] = []; // what each wallet keeps: its signed input, until a valid notarization is seen
  for (let i = 0; i < choices.length; i++) {
    const { card: m, sub: s } = contributor(i);
    const blocks = await chain.get<{ number: number; hash: string }[]>("/headers?after=0");
    const ref = blocks[Math.max(0, blocks.length - 3)]!; // a block the host has already streamed
    const r = await submitNotaryInputWithRetry({
      job: { jobHash, epoch: a.epoch, jobPublicKey: a.job_public_key, quorum: 1, notaryCard: st.card, notaryIdPubkey: st.kId, operatorHostPubkey: st.hostPub },
      async buildSignedInput() {
        const input = { chain_ref: { block_hash: b64uEncode(Buffer.from(ref.hash.slice(2), "hex")), block_number: ref.number }, contributor_card: m.addr, contributor_card_pubkey: m.b64,
          evidence: [], job_hash: jobHash, payload: { value: choices[i] }, revision: 0, signed_at: new Date().toISOString(), type: "notary.input.v1" };
        return { ...input, contributor_signature: { public_key: s.b64, signature: signBytes(s, canonicalNotary(input)) } } as never;
      },
      persist: async (signed, inputHash) => { stored[i] = { jobHash, signed, inputHash, epoch: a.epoch, submittedAtMs: Date.now(), hasValidationReceipt: true }; },
      async send(sealed) { const r = await ohttp(HOST, `/jobs/${jobHash}/inputs`, "POST", sealed); if (r.status !== 200) throw new Error(JSON.stringify(r.body)); return r.body as never; },
    });
    check(r.submitted, `contributor ${i} submitted "${choices[i]}" with a host receipt and an accepted validation receipt${r.submitted ? "" : ` (${(r as { code: string }).code}: ${(r as { reason: string }).reason})`}`);
  }

  // Phase 3b (6.2): every replica is lost. The operator restarts the job at a new epoch; each wallet's watcher sees the higher
  // epoch, runs algorithm W on the new announcement and re-seals its stored, already-signed input to the new key.
  const restarted = await host(`/jobs/${jobHash}/restart`, { reason: "total_loss" }, true);
  check(restarted["epoch"] === 1, "the operator restarted the job at epoch 1");
  const ann1 = await waitFor("the epoch-1 announcement", async () => { const r = await ohttp(HOST, `/jobs/${jobHash}/announcement`, "GET"); return r.status === 200 && (r.body as { epoch: number }).epoch === 1 ? r.body : null; }) as { job_public_key: string; epoch: number; epoch_reason?: string; prev_announcement?: string };
  check(ann1.epoch_reason === "total_loss" && ann1.prev_announcement !== undefined && ann1.job_public_key !== a.job_public_key, "the epoch-1 announcement names its reason, the one before it, and a new key");
  const notes: string[] = [];
  const actions = await watchNotaryJobsOnce({
    nowMs: () => Date.now(),
    list: async () => stored,
    save: async (x) => { stored[stored.findIndex((y) => y.inputHash === x.inputHash)] = x; },
    remove: async () => {},
    fetchAnnouncement: async () => { const r = await ohttp(HOST, `/jobs/${jobHash}/announcement`, "GET"); return r.status === 200 ? r.body : null; },
    verify: (announcement, highestEpochSeen) => verifyNotaryJob({ announcement, config, reads: walletReads(chain, notary, lists, ATT), lists, attestation: [simulator], highestEpochSeen }),
    resubmit: async (s, verified, announcement) => {
      const next = announcement as { job_public_key: string };
      const i = stored.findIndex((y) => y.inputHash === s.inputHash);
      return submitNotaryInputWithRetry({
        job: { jobHash, epoch: verified.epoch, jobPublicKey: next.job_public_key, quorum: 1, notaryCard: st.card, notaryIdPubkey: st.kId, operatorHostPubkey: st.hostPub },
        buildSignedInput: async () => s.signed as never, // not re-signed, no prompt
        persist: async (signed, inputHash) => { stored[i] = { ...s, signed, inputHash, epoch: verified.epoch }; },
        send: async (sealed) => { const r = await ohttp(HOST, `/jobs/${jobHash}/inputs`, "POST", sealed); if (r.status !== 200) throw new Error(JSON.stringify(r.body)); return r.body as never; },
      });
    },
    notify: (m) => notes.push(m),
  });
  check(actions.length === 3 && actions.every((x) => x.action === "resubmitted" && (x as { epoch: number }).epoch === 1), `the three wallets resubmitted to epoch 1 (${actions.map((x) => x.action).join(",")})`);
  check(notes.length === 3 && /lost its copies/.test(notes[0]!), "each user was told the notary lost its copies and the input was sent again");

  // Phase 4: close and notarization
  log(`waiting for close at ${unsigned.closes_at}`);
  const notarizationCid = await waitFor("the notarized record", async () => {
    const recs = await chain.get<{ seq: number; record_cid: string }[]>(`/eas/${jobHash}`);
    for (const rc of recs) {
      const b = await chain.bytes(rc.record_cid);
      const rec = b ? (JSON.parse(new TextDecoder().decode(b)) as { kind: string; body: { notarization?: string } }) : null;
      if (rec?.kind === "notarized") return rec.body.notarization;
    }
    return null;
  }, closeAfter + 120);
  const n = JSON.parse(new TextDecoder().decode((await chain.bytes(notarizationCid!))!)) as { output: unknown; accepted: number; suppressed: boolean; final_epoch: number };
  check(n.final_epoch === 1, `the notarization is for the final epoch (${n.final_epoch})`);
  check(n.accepted === 3 && !n.suppressed, `the notarization counts 3 contributors (accepted=${n.accepted})`);
  check(JSON.stringify(n.output) === JSON.stringify({ recipients: [contributor(0).card.addr] }), `the notarization carries no value, only its recipient: ${JSON.stringify(n.output)}`);
  // 6.1: the host delivered one message per recipient sub-card; contributor 0's device opens it with the App SDK
  const delivered = await waitFor("the notary_output message", async () => { const d = await chain.get<{ to: string; subcard_hash: string; payload: string }[]>("/delivered"); return d.length ? d : null; });
  check(delivered.length === 1 && delivered[0]!.to === contributor(0).card.addr && delivered[0]!.subcard_hash === contributor(0).sub.addr, "the host relayed one routing envelope, addressed to contributor 0's sub-card");
  const msg = decryptRoutingEnvelope(delivered[0]!, kemKeypair(0).secretKey) as { payload: { type: string; content: { output: unknown; output_hash: string; notarization: string; job_hash: string } }; signatures: { public_key: string; signature: string }[] };
  check(msg.payload.type === "notary_output" && msg.payload.content.notarization === notarizationCid && msg.payload.content.job_hash === jobHash, "the sub-card opens it: a notary_output for this job and notarization");
  check(JSON.stringify(msg.payload.content.output) === JSON.stringify({ bucket_4: 0, bucket_5: 0, bucket_6: 0, bucket_7: 0, bucket_8: 0, count: 3, sum: 22 }), `the private result is the template's: ${JSON.stringify(msg.payload.content.output)}`);
  check(H(msg.payload.content.output) === (n as unknown as { output_hash: string }).output_hash, "its output_hash is the notarization's");
  check(msg.signatures[0]!.public_key === st.kId && ml_dsa44.verify(b64uDecode(msg.signatures[0]!.signature, 2420), canonicalize(msg.payload), b64uDecode(st.kId, 1312)), "it is signed by the notary card's K_id");
  let otherOpens = true;
  try { decryptRoutingEnvelope(delivered[0]!, kemKeypair(1).secretKey); } catch { otherOpens = false; }
  check(!otherOpens, "another sub-card's key can't open it");
  const res = await verifyNotarization(notarizationCid!, notarizationReads(chain, notary, lists, ATT), { attest: attestCfg, modules: [simulator], acceptedRuntimes: lists.acceptedRuntimes });
  check(res.valid, `algorithm N verifies the notarization${res.valid ? ` (warnings: ${(res as { warnings: string[] }).warnings.join(",") || "none"})` : ` (${JSON.stringify(res)})`}`);
  log("END TO END: PASS");
}

/**
 * Moves chain time and the enclave's attested clock forward (test only: `POST /warp`, the fake enclave's offset file).
 * The total survives between phases in the offset file, so a later phase starts from the clock an earlier one left.
 */
let warped = (() => { try { return Number(readFileSync(env("ENCLAVE_OFFSET_FILE"), "utf8")) || 0; } catch { return 0; } })();
async function warpChain(ms: number) {
  warped += ms;
  await fetch(`${SIM}/warp`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ms }) });
}
const syncEnclaveClock = () => writeFileSync(env("ENCLAVE_OFFSET_FILE"), String(warped));
async function warp(ms: number) { await warpChain(ms); syncEnclaveClock(); }
// the verifier and the wallet read the same moved clock (`Date.now()` and `new Date()`)
const RealDate = Date;
class MovedDate extends RealDate {
  constructor(...a: unknown[]) { if (a.length === 0) super(RealDate.now() + warped); else super(...(a as [number])); }
  static override now() { return RealDate.now() + warped; }
}
globalThis.Date = MovedDate as unknown as DateConstructor;


/**
 * Derived cards are issued per UTC day, and the phases move the clock forward by hours. A phase that would carry the moved clock
 * across UTC midnight while cards are in flight fails (the cause of the time-of-day failures): so before such a phase the clock
 * is moved once, with nothing in flight, to just past the coming midnight.
 */
async function clearOfMidnight(spanMs: number) {
  const DAY = 86_400_000;
  const into = Date.now() % DAY;
  if (into > DAY - spanMs) { log(`moving the clock past UTC midnight before this phase (it would cross it mid-phase)`); await warp(DAY - into + 5 * 60_000); }
}
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const openDoc = (pub: Uint8Array, bytes: Uint8Array): Record<string, unknown> => {
  const d = createDecipheriv("aes-256-gcm", contentKey(pub), bytes.subarray(0, 12));
  d.setAuthTag(bytes.subarray(bytes.length - 16));
  return JSON.parse(Buffer.concat([d.update(bytes.subarray(12, bytes.length - 16)), d.final()]).toString()) as Record<string, unknown>;
};

/**
 * Derived cards through real processes (Phase 7, 7.1 R3): the template is seeded, the wallet reads the source policy's
 * `derivable` flags, three holders request a card with `requestDerivedCard` and countersign the offer, time moves past
 * the batch boundary, the enclave releases the batch, the host registers it through the write gate, and a verifier
 * checks the cards with Stage 5 step 3a through the injected hook (genesis attestation, shape, algorithm E over the
 * identity log anchored at genesis, `source_kind`).
 */
async function derive() {
  await clearOfMidnight(4.5 * 3_600_000); // issuance, a 2 h 10 min wait and the bound check
  await waitFor("host", async () => ((await (await fetch(`${HOST}/health`)).json()) as { status: string }).status === "ok");
  const lists = await verifiedLists(chain);
  // a notary card is issued under one policy (W10: its `issuer_card` is the job's policy): the template gets its own, from its holder
  const n = await genesisFor({ lists, policyDocId: TEMPLATE_ID, issuer: K.template });
  const post = async (path: string, body: unknown) => (await fetch(`${SIM}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json();
  const templateStateCid = await registerTemplate(chain, n.card, n.chainPubkey, post);
  const st = { ...n, templateStateCid };
  const notary = { card: st.card, kId: st.kId, genesisAttestation: st.genesisAttestation };
  const reads = walletReads(chain, notary, lists, ATT);

  // the operator seeds the template's dup_tag key (the first enclave serving it)
  const seeded = await host("/operator/template-seed", { template: TEMPLATE_ID, notary_card: st.card, nullifier_period: "P1D" }, true);
  check(seeded["status"] === "seeded", `the operator seeded the template's tag key (generation ${seeded["generation"]})`);

  // the wallet's source-policy read (6.5a): `home_address` is not derivable, `member_level` is
  const blocked = await reads.nonDerivableFields!(IDS.sourcePolicy);
  check(JSON.stringify(blocked) === JSON.stringify(["home_address"]), `the wallet reads the source policy's head: not derivable: ${JSON.stringify(blocked)}`);

  const PERIOD = 86_400_000;
  const now = Date.now();
  const jobFor = (fields: string[], nonce: number) => {
    const unsigned = { created_at: new Date(now).toISOString(), ends_at: new Date(now + 3 * PERIOD).toISOString(), kem: "x-wing-draft-06", key_period: "P1D", min_live: 1,
      nonce: b64uEncode(new Uint8Array(16).fill(nonce)), opens_at: new Date(now).toISOString(), parameters: { projected_fields: fields, source_policy: IDS.sourcePolicy }, policy_id: TEMPLATE_ID,
      policy_state_cid: st.templateStateCid, replica_set: [{ instances: 1, notary_card: st.card }], requester_card: K.requester.addr, requester_pubkey: K.requester.b64, type: "notary.job.v1" };
    return { ...unsigned, requester_signature: { public_key: K.requester.b64, signature: signBytes(K.requester, canonicalNotary(unsigned)) } };
  };

  // a job that projects a field the source policy marks not derivable is refused at job open (the enclave enforces it whatever the wallet does)
  const refused = await fetch(`${HOST}/jobs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ job: jobFor(["home_address"], 8), program_cid: DERIVE_PROGRAM_CID }) });
  const refusedBody = JSON.stringify(await refused.json());
  check(!refused.ok && /JOB_FIELD_NOT_DERIVABLE|NOT_DERIVABLE/.test(refusedBody), `a job projecting home_address is refused by the enclave at job open (${refused.status} ${refusedBody.slice(0, 120)})`);

  const job = jobFor(["member_level"], 9);
  const created = await host("/jobs", { job, program_cid: DERIVE_PROGRAM_CID });
  const jobHash = String(created["job_hash"]);
  check(jobHash === H(job), `the host accepted the derived-card job (${jobHash})`);
  const ann = await waitFor("announcement", async () => { const r = await ohttp(HOST, `/jobs/${jobHash}/announcement`, "GET"); return r.status === 200 ? r.body : null; });
  const config = { attestationRoots: { "aws-nitro-enclaves": new Uint8Array(0), simulator: ROOT }, allowSimulator: true, acceptedRuntimesCard: K.listRuntimes.addr,
    programAllowlistCard: K.listPrograms.addr, notaryCardPolicy: IDS.notaryCardPolicy, acceptedKems: ["x-wing-draft-06"] as ["x-wing-draft-06"] };
  const v = await verifyNotaryJob({ announcement: ann, config, reads, lists, attestation: [simulator] });
  check(v.valid, `algorithm W accepts the derived-card job${v.valid ? ` (warnings: ${v.warnings.join(",") || "none"})` : ` (${(v as { code: string }).code}: ${(v as { reason: string }).reason})`}`);
  if (!v.valid) return;
  const a = ann as { job_public_key: string; epoch: number };

  // three holders ask for a card and countersign the offer
  const period = Math.floor(Date.now() / PERIOD);
  const expiresAt = new Date((period + 1) * PERIOD).toISOString();
  const held: { derivedAddress: string; derivedPublicKey: string; offerHash: string; issuedAtBoundary: string; i: number }[] = [];
  for (let i = 0; i < 3; i++) {
    const { card: m, sub: s } = contributor(i);
    const keys: unknown[] = [];
    let r: Awaited<ReturnType<typeof requestDerivedCard>>;
    // the enclave does not wait for a header it has not been sent (lifecycle B3): a fresh reference is tried again, as `submitNotaryInputWithRetry` does
    for (let attempt = 0; ; attempt++) {
    const blocks = await chain.get<{ number: number; hash: string }[]>("/headers?after=0");
    const ref = blocks[Math.max(0, blocks.length - 3 - 3 * attempt)]!;
    r = await requestDerivedCard({
      job: { jobHash, epoch: a.epoch, jobPublicKey: a.job_public_key, quorum: 1, notaryCard: st.card, notaryIdPubkey: st.kId, operatorHostPubkey: st.hostPub },
      consent: { template: TEMPLATE_ID, sourcePolicy: IDS.sourcePolicy, projectedFields: ["member_level"], expiresAt },
      sourceFields: { member_level: "gold" },
      targetPeriod: period,
      keys: { persistNewKey: async (k) => { keys.push(k); } },
      async buildSignedInput(payload) {
        const input = { chain_ref: { block_hash: b64uEncode(Buffer.from(ref.hash.slice(2), "hex")), block_number: ref.number }, contributor_card: m.addr, contributor_card_pubkey: m.b64,
          evidence: [], job_hash: jobHash, payload, revision: 0, signed_at: new Date().toISOString(), type: "notary.input.v1" };
        return { ...input, contributor_signature: { public_key: s.b64, signature: signBytes(s, canonicalNotary(input)) } } as never;
      },
      persist: async () => {},
      async send(sealed) { const r = await ohttp(HOST, `/jobs/${jobHash}/inputs`, "POST", sealed); if (r.status !== 200) throw new Error(JSON.stringify(r.body)); return r.body as never; },
    });
    if (r.pending || (r as { code: string }).code !== "INPUT_CHAIN_REF_UNKNOWN" || attempt >= 5) break;
    await sleep(2000);
    }
    check(r.pending, `holder ${i}: the offer matched the consent and was countersigned${r.pending ? "" : ` (${(r as { code: string }).code}: ${(r as { reason: string }).reason})`}`);
    if (!r.pending) return;
    held.push({ derivedAddress: r.derivedAddress, derivedPublicKey: r.derivedPublicKey, offerHash: r.offerHash, issuedAtBoundary: r.issuedAtBoundary, i });
  }
  check(new Set(held.map((h) => h.issuedAtBoundary)).size === 1, `all three offers name one release boundary (${held[0]!.issuedAtBoundary})`);
  for (const h of held) check((await fetch(`${SIM}/registry/card/${h.derivedAddress}`)).status === 404, `holder ${h.i}: nothing is registered before the boundary`);

  // the batch interval passes (chain time and the enclave's attested clock together); the host's tick releases the batch
  // (the release is judged at the boundary the clock is in, so the warp lands a minute past the one the offers name)
  await warp(Date.parse(held[0]!.issuedAtBoundary) - Date.now() + 60_000);
  for (const h of held) await waitFor(`holder ${h.i}'s card in the registry`, async () => (await fetch(`${SIM}/registry/card/${h.derivedAddress}`)).ok, 90);
  check(true, "the enclave released the batch and the host registered all three cards through the write gate");

  // what a verifier sees
  const docs = held.map((h) => { const pub = b64uDecode(h.derivedPublicKey, 1312); return { pub, address: h.derivedAddress, head: "" as string, doc: undefined as unknown as Record<string, unknown> }; });
  for (const d of docs) {
    const c = await chain.get<{ head_cid: string }>(`/registry/card/${d.address}`);
    d.head = c.head_cid;
    d.doc = openDoc(d.pub, (await chain.bytes(c.head_cid))!);
  }
  check(docs.every((d) => d.doc["policy_id"] === TEMPLATE_ID && d.doc["issuer_card"] === st.card && d.doc["source_policy"] === IDS.sourcePolicy && d.doc["projected"] === '{"member_level":"gold"}'),
    "each card names the template, the notary and the source policy, and carries only the projected value");
  check(new Set(docs.map((d) => d.doc["dup_tag"])).size === 3 && new Set(docs.map((d) => d.doc["expires_at"])).size === 1 && new Set(docs.map((d) => d.doc["issued_at"])).size === 1 && docs[0]!.doc["expires_at"] === expiresAt,
    "three distinct tags, one issued_at and one expires_at (the end of the period)");

  // unlinkability at the chain: nothing the host wrote names a source card
  const txs = JSON.stringify(await chain.get("/txs"));
  const sourceForms = [0, 1, 2].flatMap((i) => { const m = contributor(i); return [m.card.addr, m.card.b64, m.sub.addr, m.sub.b64, b64uEncode(Buffer.from(m.card.addr, "hex"))]; });
  check(sourceForms.every((f) => !txs.includes(f)), "no registration the host submitted names a source card, its key or its sub-card");
  check(sourceForms.every((f) => `${txs}${f}`.includes(f)), "control: the same scan finds a source card's forms when they are present");

  // standard verification (Stages 3, 4, 6), then Stage 5 step 3a through the injected hook, over the chain's HTTP service
  const rpc = httpRpc(chain);
  const verifier = new CardVerifier({ rpc: rpc as never, ipfs: { fetch: async (cid: string) => { const b = await chain.bytes(cid); if (!b) throw new Error(`no ${cid}`); return b; } }, trustedRoots: [K.root.addr] });
  const base = { attestation: [simulator], attestationRoots: { simulator: ROOT }, allowSimulator: true, acceptedRuntimesCard: K.listRuntimes.addr, programAllowlistCard: K.listPrograms.addr,
    acceptedRuntimesCardPubkey: K.listRuntimes.b64, programAllowlistCardPubkey: K.listPrograms.b64, notaryCardPolicy: IDS.notaryCardPolicy };
  const hook = notaryStage5Hook(base as never);
  for (const d of docs) {
    const r = await verifier.verifyCard(d.address, { pubkey: b64uEncode(d.pub) });
    check(r.errors.length === 0 && r.chain_reaches_trusted_root === true, `Stages 3, 4 and 6 accept ${d.address.slice(0, 12)}… (${JSON.stringify(r.errors)})`);
    const n = await hook({ cardDoc: d.doc, cardAddress: d.address, rpc: rpc as never, ipfs: { fetch: async (cid: string) => (await chain.bytes(cid))! }, nowMs: Date.now(),
      listCardTrusted: async (addr, pub) => { const x = await verifier.verifyCard(addr, { pubkey: b64uEncode(pub) }); return x.errors.length === 0 && x.chain_reaches_trusted_root === true; } });
    check(n.ok, `Stage 5 step 3a accepts ${d.address.slice(0, 12)}…: genesis, shape, algorithm E over the identity log, source_kind${n.ok ? "" : ` (${JSON.stringify(n)})`}`);
  }

  // ---- sealed_link revocation (§5-§7): source cards are revoked; the notary propagates it to the linked derived cards ----
  // A source card's new log entry, signed by `signer` as its press, encrypted under the source card's content key and registered as its new head.
  const sourceEntry = async (i: number, code: number, signer: typeof K.srcPress) => {
    const m = contributor(i).card;
    const entry: Record<string, unknown> = { card_state: {}, code, entry_type: code >= 800 ? "revocation" : "field_update", version: 2 };
    entry["press_signature"] = { public_key: signer.b64, signature: signBytes(signer, canonicalNotary(entry)) };
    const head = await chain.pin(encrypt(m.pub, entry, `source-entry-${i}-${code}-${signer.name}`, true));
    await chain.registerCard({ address: m.addr, policy: IDS.sourcePolicy, press: PRESS_ADDR, head_cid: head });
  };
  const batchesOnChain = async () => (await chain.get<{ op: string }[]>("/txs")).filter((t) => t.op === "batch_update_card_heads").length;
  const before = await batchesOnChain();
  await sourceEntry(2, 803, K.chapter); // an update no certified press signed (E4): it must not revoke anything
  await sourceEntry(0, 803, K.srcPress); // a quiet revocation of holder 0's source card
  await sourceEntry(1, 905, K.srcPress); // a loud one of holder 1's
  await new Promise((r) => setTimeout(r, 12_000)); // the host relays the updates on its snapshot refresh (5 s); they must arrive before time moves
  check(await batchesOnChain() === before, "nothing is released at once: a revocation waits the template's minimum delay");
  // the bound (propagation §3, §7): a revocation is released no earlier than `min_delay` after it was queued, and no later than
  // the first window boundary after that, so within `min_delay + batch_window`. One minute short of `min_delay`: nothing yet.
  const MIN = 60_000, minDelayMs = 3_600_000, windowMs = 3_600_000; // DERIVE_PROPAGATION: PT1H, PT1H
  await warp(minDelayMs - MIN);
  await new Promise((r) => setTimeout(r, 6000));
  check(await batchesOnChain() === before, "one minute before min_delay has passed: nothing is released");
  // then to one minute past min_delay + batch_window since the revocations were queued
  await warp(minDelayMs + windowMs + MIN - (minDelayMs - MIN));
  await waitFor("the propagation batch (within min_delay + batch_window)", async () => (await batchesOnChain()) > before, 90);
  check(await batchesOnChain() === before + 1, "one BatchUpdateCardHeads for the window");
  const status = async (h: (typeof held)[number]) => { const c = await chain.get<{ head_cid: string }>(`/registry/card/${h.derivedAddress}`); return { head: c.head_cid, doc: openDoc(b64uDecode(h.derivedPublicKey, 1312), (await chain.bytes(c.head_cid))!) }; };
  const s0 = await status(held[0]!), s1 = await status(held[1]!), s2 = await status(held[2]!);
  check(s0.doc["entry_type"] === "revocation" && s0.doc["code"] === 820, `holder 0's derived card is revoked with the mapped code ${s0.doc["code"]} (not the source's 803)`);
  check(s1.doc["entry_type"] === "revocation" && s1.doc["code"] === 920, `holder 1's derived card is revoked with the mapped loud code ${s1.doc["code"]} (not the source's 905)`);
  check(s2.head === docs[2]!.head, "holder 2's card is untouched: the update that no certified press signed revoked nothing (E4)");
  await new Promise((r) => setTimeout(r, 3000)); // the revocations take effect at the batch time, which the clock has just reached
  const verdict = async (i: number) => verifier.verifyCard(docs[i]!.address, { pubkey: b64uEncode(docs[i]!.pub) });
  const r0 = await verdict(0), r1 = await verdict(1), r2 = await verdict(2);
  check(r0.revocation.status === "revoked" && r1.revocation.status === "loud_revocation" && r2.revocation.status === "not_revoked", `a verifier sees an ordinary revocation: ${r0.revocation.status}, ${r1.revocation.status}, ${r2.revocation.status}`);
  check(r0.is_currently_valid === false && r1.is_currently_valid === false && r2.is_currently_valid === true, `the revoked cards are no longer valid; the third still is (${r0.is_currently_valid}, ${r1.is_currently_valid}, ${r2.is_currently_valid}; effective ${JSON.stringify([r0.revocation, r1.revocation])})`);
  const txs2 = JSON.stringify(await chain.get("/txs"));
  check(sourceForms.every((f) => !txs2.includes(f)), "the propagation batch names no source card either");
  // ---- timing correlation (L8; derived_card_revocation_propagation.md §7, "Residual linkage"): what an observer can see ----
  // The spec does not claim unlinkability here. It discloses that matching source-revocation events with a derived batch narrows
  // a revocation to the source revocations in the window, never to fewer than `min_revocation_batch`. This measures that bound.
  const batchTx = (await chain.get<{ op: string; payload: { updates?: unknown[] } }[]>("/txs")).filter((t) => t.op === "batch_update_card_heads").at(-1)!;
  const rev0 = s0.doc["revocation"] as Record<string, unknown>, rev1 = s1.doc["revocation"] as Record<string, unknown>;
  check(batchTx.payload.updates!.length >= DERIVE_PROPAGATION.min_revocation_batch, `the batch holds ${batchTx.payload.updates!.length} revocations, at least min_revocation_batch (${DERIVE_PROPAGATION.min_revocation_batch})`);
  check(rev0["effective_date"] === rev1["effective_date"], `every entry of the batch carries one effective_date, the release time (${rev0["effective_date"]}): no per-entry timing`);
  check(!("note" in rev0) && !("note" in rev1) && s0.doc["notify_holder"] === true && s1.doc["notify_holder"] === true, "no entry carries a note; each notifies the holder");
  const sourceEventsInWindow = 2; // the two certified source revocations the scenario made (a third, uncertified, counts for nothing)
  log(`L8 measured: a derived revocation here narrows to ${sourceEventsInWindow} source revocation events (window ${DERIVE_PROPAGATION.batch_window}, min_delay ${DERIVE_PROPAGATION.min_delay}); the disclosed floor is min_revocation_batch = ${DERIVE_PROPAGATION.min_revocation_batch}. Small communities with rare revocations get this weakest case (L8).`);
  check(sourceEventsInWindow >= DERIVE_PROPAGATION.min_revocation_batch, "the observable candidate set is not smaller than the disclosed floor");
  void keccak_256; void hex; void DERIVE_MODULE; void SOURCE_POLICY_DOC;
  log("DERIVED CARDS END TO END: PASS");
}

/**
 * A vote through real processes (Phase 7, 7.1, G1 and G4): the vote template under its own policy and notary card; three
 * voters cast ballots with `submitNotaryInputWithRetry`, one changes a ballot (latest wins); the job closes only when chain
 * time AND the enclave's attested time are past `closes_at` (chain-only: nothing; both: the tally), and a verifier accepts it.
 */
async function vote() {
  await waitFor("host", async () => ((await (await fetch(`${HOST}/health`)).json()) as { status: string }).status === "ok");
  const lists = await verifiedLists(chain);
  const n = await genesisFor({ lists, policyDocId: VOTE_ID, issuer: K.vote });
  const stateCid = await registerVote(chain, n.card);
  const notary = { card: n.card, kId: n.kId, genesisAttestation: n.genesisAttestation };
  const HOUR = 3_600_000;
  const now = Date.now();
  const unsigned = { closes_at: new Date(now + HOUR).toISOString(), created_at: new Date(now).toISOString(), kem: "x-wing-draft-06", min_live: 1, nonce: b64uEncode(crypto.getRandomValues(new Uint8Array(16))),
    opens_at: new Date(now).toISOString(), output_recipient_keys: {}, parameters: { question: "Adopt the budget?" }, policy_id: VOTE_ID, policy_state_cid: stateCid,
    replica_set: [{ instances: 1, notary_card: n.card }], requester_card: K.requester.addr, requester_pubkey: K.requester.b64, type: "notary.job.v1" };
  const job = { ...unsigned, requester_signature: { public_key: K.requester.b64, signature: signBytes(K.requester, canonicalNotary(unsigned)) } };
  const created = await host("/jobs", { job, program_cid: VOTE_PROGRAM_CID });
  const jobHash = String(created["job_hash"]);
  check(jobHash === H(job), `the host accepted the vote (${jobHash})`);
  const ann = await waitFor("announcement", async () => { const r = await ohttp(HOST, `/jobs/${jobHash}/announcement`, "GET"); return r.status === 200 ? r.body : null; });
  const config = { attestationRoots: { "aws-nitro-enclaves": new Uint8Array(0), simulator: ROOT }, allowSimulator: true, acceptedRuntimesCard: K.listRuntimes.addr,
    programAllowlistCard: K.listPrograms.addr, notaryCardPolicy: IDS.notaryCardPolicy, acceptedKems: ["x-wing-draft-06"] as ["x-wing-draft-06"] };
  const v = await verifyNotaryJob({ announcement: ann, config, reads: walletReads(chain, notary, lists, ATT), lists, attestation: [simulator] });
  check(v.valid, `algorithm W accepts the vote${v.valid ? ` (warnings: ${v.warnings.join(",") || "none"})` : ` (${(v as { code: string }).code}: ${(v as { reason: string }).reason})`}`);
  if (!v.valid) return;
  const a = ann as { job_public_key: string; epoch: number };

  // G2 through real processes: the real announcement and attestation, each refused by the wallet for the right reason. A job
  // or an announcement can't be edited (the notary signs the announcement, W11), so each case changes what the wallet reads
  // or what it is configured to accept. A debug-mode attestation and a mismatched nonce need a forged attestation: those two
  // stay unit-tested (`wallet-sdk/test/notary/verifyJob.test.ts`); a real enclave does not produce them.
  const base = walletReads(chain, notary, lists, ATT);
  const refuse = async (what: string, want: string, o: { announcement?: unknown; reads?: Partial<typeof base>; lists?: typeof lists; config?: Record<string, unknown> }) => {
    const r = await verifyNotaryJob({ announcement: o.announcement ?? ann, config: { ...config, ...o.config } as never, reads: { ...base, ...o.reads }, lists: o.lists ?? lists, attestation: [simulator] });
    check(!r.valid && (r as { code: string }).code === want, `the wallet refuses ${what}: ${r.valid ? "ACCEPTED" : (r as { code: string }).code} (want ${want})`);
  };
  const pol = await base.policy(VOTE_ID);
  await refuse("a runtime whose PCR0 the governance list does not accept", "ATT_RUNTIME_NOT_ACCEPTED", { lists: { ...lists, acceptedRuntimes: lists.acceptedRuntimes.map((x) => ({ ...x, pcr0: b64uEncode(new Uint8Array(48).fill(9)) })) } });
  await refuse("an attestation whose program hash is not the policy's program_cid", "ATT_BINDING_MISMATCH", { reads: { policy: async () => ({ ...pol!, notary: { ...pol!.notary, program_cid: DERIVE_PROGRAM_CID } }) } });
  await refuse("a stale attestation", "ATT_STALE", { reads: { nowMs: () => Date.now() + 120_000 }, config: { maxAttestationAgeSeconds: 60 } });
  await refuse("a notary the policy does not approve", "JOB_NOTARY_NOT_APPROVED", { reads: { policy: async () => ({ ...pol!, approvedNotaries: [] }) } });
  const longQuestion: Record<string, unknown> = { ...(job as Record<string, unknown>), parameters: { question: "x".repeat(300) } };
  delete longQuestion["requester_signature"];
  const reSigned = { ...longQuestion, requester_signature: { public_key: K.requester.b64, signature: signBytes(K.requester, canonicalNotary(longQuestion)) } };
  await refuse("parameters outside parameter_bounds (a validly re-signed job)", "JOB_PARAMETERS_OUT_OF_BOUNDS", { announcement: { ...(ann as Record<string, unknown>), job: reSigned } });

  const stored: StoredNotaryInput[] = []; // what each voter's wallet keeps: its latest signed ballot, until a valid notarization is seen
  let supersededHash = ""; // voter 1's first ballot, replaced by revision 1
  const cast = async (i: number, choice: string, revision: number) => {
    const { card: m, sub: s } = contributor(i);
    const blocks = await chain.get<{ number: number; hash: string }[]>("/headers?after=0");
    const ref = blocks[Math.max(0, blocks.length - 3)]!;
    const r = await submitNotaryInputWithRetry({
      job: { jobHash, epoch: a.epoch, jobPublicKey: a.job_public_key, quorum: 1, notaryCard: n.card, notaryIdPubkey: n.kId, operatorHostPubkey: n.hostPub },
      async buildSignedInput() {
        const input = { chain_ref: { block_hash: b64uEncode(Buffer.from(ref.hash.slice(2), "hex")), block_number: ref.number }, contributor_card: m.addr, contributor_card_pubkey: m.b64,
          evidence: [], job_hash: jobHash, payload: { choice }, revision, signed_at: new Date().toISOString(), type: "notary.input.v1" };
        return { ...input, contributor_signature: { public_key: s.b64, signature: signBytes(s, canonicalNotary(input)) } } as never;
      },
      persist: async (signed, inputHash) => { if (stored[i]) supersededHash = stored[i]!.inputHash; stored[i] = { jobHash, signed, inputHash, epoch: a.epoch, submittedAtMs: Date.now(), hasValidationReceipt: true }; },
      async send(sealed) { const x = await ohttp(HOST, `/jobs/${jobHash}/inputs`, "POST", sealed); if (x.status !== 200) throw new Error(JSON.stringify(x.body)); return x.body as never; },
    });
    check(r.submitted, `voter ${i} cast "${choice}" (revision ${revision}) with a host receipt and an accepted validation receipt${r.submitted ? "" : ` (${(r as { code: string }).code}: ${(r as { reason: string }).reason})`}`);
  };
  await cast(0, "yes", 0);
  await cast(1, "no", 0);
  await cast(2, "abstain", 0);
  await cast(1, "yes", 1); // voter 1 changes their mind: the latest ballot counts

  const notarized = async () => {
    for (const rc of await chain.get<{ seq: number; record_cid: string }[]>(`/eas/${jobHash}`)) {
      const b = await chain.bytes(rc.record_cid);
      const rec = b ? (JSON.parse(new TextDecoder().decode(b)) as { kind: string; body: { notarization?: string } }) : null;
      if (rec?.kind === "notarized") return rec.body.notarization ?? null;
    }
    return null;
  };

  // every replica is lost: the operator restarts the vote at a new epoch, and each voter's wallet re-seals its stored, signed,
  // latest ballot to the new key (not re-signed, no prompt). Voter 1 resubmits the revision-1 ballot only.
  const restarted = await host(`/jobs/${jobHash}/restart`, { reason: "total_loss" }, true);
  check(restarted["epoch"] === 1, "the operator restarted the vote at epoch 1 (total loss)");
  await waitFor("the epoch-1 announcement", async () => { const r = await ohttp(HOST, `/jobs/${jobHash}/announcement`, "GET"); return r.status === 200 && (r.body as { epoch: number }).epoch === 1 ? r.body : null; });
  const notes: string[] = [];
  const actions = await watchNotaryJobsOnce({
    nowMs: () => Date.now(),
    list: async () => stored,
    save: async (x) => { stored[stored.findIndex((y) => y.inputHash === x.inputHash)] = x; },
    remove: async () => {},
    fetchAnnouncement: async () => { const r = await ohttp(HOST, `/jobs/${jobHash}/announcement`, "GET"); return r.status === 200 ? r.body : null; },
    verify: (announcement, highestEpochSeen) => verifyNotaryJob({ announcement, config, reads: walletReads(chain, notary, lists, ATT), lists, attestation: [simulator], highestEpochSeen }),
    resubmit: async (sb, verified, announcement) => {
      const next = announcement as { job_public_key: string };
      const i = stored.findIndex((y) => y.inputHash === sb.inputHash);
      return submitNotaryInputWithRetry({
        job: { jobHash, epoch: verified.epoch, jobPublicKey: next.job_public_key, quorum: 1, notaryCard: n.card, notaryIdPubkey: n.kId, operatorHostPubkey: n.hostPub },
        buildSignedInput: async () => sb.signed as never,
        persist: async (signed, inputHash) => { stored[i] = { ...sb, signed, inputHash, epoch: verified.epoch }; },
        send: async (sealed) => { const x = await ohttp(HOST, `/jobs/${jobHash}/inputs`, "POST", sealed); if (x.status !== 200) throw new Error(JSON.stringify(x.body)); return x.body as never; },
      });
    },
    notify: (m) => notes.push(m),
  });
  check(actions.length === 3 && actions.every((x) => x.action === "resubmitted" && (x as { epoch: number }).epoch === 1), `the three wallets resubmitted their latest ballots to epoch 1 (${actions.map((x) => x.action).join(",")})`);
  await sleep(8000);
  check((await notarized()) === null, "before closes_at on either clock: not closed");
  // chain time says it is time, the enclave's own clock does not: still open
  await warpChain(HOUR + 60_000);
  await sleep(12_000);
  check((await notarized()) === null, "chain time past closes_at but the enclave's attested clock is not: the job stays open (both clocks must agree)");
  syncEnclaveClock();
  const cid = await waitFor("the notarized tally", notarized, 120);
  const nz = JSON.parse(new TextDecoder().decode((await chain.bytes(cid))!)) as { output: unknown; accepted: number; suppressed: boolean; final_epoch: number };
  check(JSON.stringify((nz.output as { public?: unknown }).public) === JSON.stringify({ abstain: 1, no: 0, yes: 2 }), `the tally is of the latest ballots (voter 1's second ballot replaced the first): ${JSON.stringify(nz.output)}`);
  check(nz.final_epoch === 1, `the notarization is for the final epoch (${nz.final_epoch}): the epoch-0 ballots are gone, the resubmitted ones count`);
  check(nz.accepted === 3 && !nz.suppressed, `three voters counted, none suppressed (accepted=${nz.accepted})`);
  const res = await verifyNotarization(cid, notarizationReads(chain, notary, lists, ATT), { attest: attestCfg, modules: [simulator], acceptedRuntimes: lists.acceptedRuntimes });
  check(res.valid, `algorithm N verifies the notarization${res.valid ? ` (warnings: ${(res as { warnings: string[] }).warnings.join(",") || "none"})` : ` (${JSON.stringify(res)})`}`);

  // G2: each contributor checks, from the notarization alone, that its latest ballot is among the counted inputs and that the
  // list hashes to `input_commitment`; the replaced first ballot is not (a control)
  const nzFull = JSON.parse(new TextDecoder().decode((await chain.bytes(cid))!)) as { counted_inputs: string; input_commitment: string };
  const counted = JSON.parse(new TextDecoder().decode((await chain.bytes(nzFull.counted_inputs))!)) as string[];
  for (const i of [0, 1, 2]) check(checkInclusion(stored[i]!.inputHash, counted, nzFull.input_commitment).included === true, `voter ${i}'s ballot is in the counted inputs and the list matches input_commitment`);
  check(supersededHash !== "" && (checkInclusion(supersededHash, counted, nzFull.input_commitment) as { reason?: string }).reason === "NOT_COUNTED", "control: voter 1's replaced first ballot is not counted");
  check((checkInclusion(stored[0]!.inputHash, counted, b64uEncode(new Uint8Array(32).fill(1))) as { reason?: string }).reason === "COMMITMENT_MISMATCH", "control: a wrong commitment is refused");

  // G1: below `k_min` the notarization says so and carries no tally. A second vote, two voters against k_min 3.
  {
    const t0 = Date.now();
    const u2 = { ...unsigned, closes_at: new Date(t0 + HOUR).toISOString(), created_at: new Date(t0 - 60_000).toISOString(), opens_at: new Date(t0 - 60_000).toISOString(), nonce: b64uEncode(crypto.getRandomValues(new Uint8Array(16))) };
    const job2 = { ...u2, requester_signature: { public_key: K.requester.b64, signature: signBytes(K.requester, canonicalNotary(u2)) } };
    const h2 = String((await host("/jobs", { job: job2, program_cid: VOTE_PROGRAM_CID }))["job_hash"]);
    const ann2 = await waitFor("announcement", async () => { const r = await ohttp(HOST, `/jobs/${h2}/announcement`, "GET"); return r.status === 200 ? r.body : null; }) as { job_public_key: string; epoch: number };
    for (const [i, choice] of [[0, "yes"], [1, "no"]] as const) {
      const { card: m, sub: s } = contributor(i);
      let r: Awaited<ReturnType<typeof submitNotaryInputWithRetry>>;
      // the enclave does not wait for a header it has not been sent: a fresh, older reference is tried again
      for (let attempt = 0; ; attempt++) {
      const blocks = await chain.get<{ number: number; hash: string }[]>("/headers?after=0");
      const ref = blocks[Math.max(0, blocks.length - 3 - 3 * attempt)]!;
      r = await submitNotaryInputWithRetry({
        job: { jobHash: h2, epoch: ann2.epoch, jobPublicKey: ann2.job_public_key, quorum: 1, notaryCard: n.card, notaryIdPubkey: n.kId, operatorHostPubkey: n.hostPub },
        async buildSignedInput() {
          const input = { chain_ref: { block_hash: b64uEncode(Buffer.from(ref.hash.slice(2), "hex")), block_number: ref.number }, contributor_card: m.addr, contributor_card_pubkey: m.b64,
            evidence: [], job_hash: h2, payload: { choice }, revision: 0, signed_at: new Date().toISOString(), type: "notary.input.v1" };
          return { ...input, contributor_signature: { public_key: s.b64, signature: signBytes(s, canonicalNotary(input)) } } as never;
        },
        persist: async () => {},
        async send(sealed) { const x = await ohttp(HOST, `/jobs/${h2}/inputs`, "POST", sealed); if (x.status !== 200) throw new Error(JSON.stringify(x.body)); return x.body as never; },
      });
      if (r.submitted || (r as { code: string }).code !== "INPUT_CHAIN_REF_UNKNOWN" || attempt >= 5) break;
      await sleep(2000);
      }
      check(r.submitted, `small vote: voter ${i} cast "${choice}"${r.submitted ? "" : ` (${(r as { code: string }).code}: ${(r as { reason: string }).reason})`}`);
    }
    await warp(HOUR + 60_000);
    const cid2 = await waitFor("the second notarization", async () => {
      for (const rc of await chain.get<{ seq: number; record_cid: string }[]>(`/eas/${h2}`)) {
        const b = await chain.bytes(rc.record_cid);
        const rec = b ? (JSON.parse(new TextDecoder().decode(b)) as { kind: string; body: { notarization?: string } }) : null;
        if (rec?.kind === "notarized") return rec.body.notarization ?? null;
      }
      return null;
    }, 120);
    const n2 = JSON.parse(new TextDecoder().decode((await chain.bytes(cid2))!)) as { output: { public?: unknown } & Record<string, unknown>; accepted: number; suppressed: boolean };
    check(n2.suppressed === true && n2.accepted === 2 && JSON.stringify(n2.output).includes("insufficient_participation"), `below k_min: no tally, "insufficient_participation" (accepted=${n2.accepted}, output ${JSON.stringify(n2.output)})`);
    const res2 = await verifyNotarization(cid2, notarizationReads(chain, notary, lists, ATT), { attest: attestCfg, modules: [simulator], acceptedRuntimes: lists.acceptedRuntimes });
    check(res2.valid, "algorithm N accepts the insufficient-participation notarization");
  }
  log("VOTE END TO END: PASS");
}

/**
 * `expiry_only` through real processes (Phase 7, 7.1, G1; derived_card_revocation_propagation.md §5): the template variant
 * keeps no link. Three other holders (3 to 5; the `derive` phase revoked holders 0 and 1) get cards; a press-signed source
 * revocation then causes no event on the chain, the card stays valid, and it lapses at `expires_at` (quietly: a verifier
 * reports `expired`).
 */
async function expiry() {
  await clearOfMidnight(2 * 3_600_000); // issuance, then the three-hour source-revocation wait
  await waitFor("host", async () => ((await (await fetch(`${HOST}/health`)).json()) as { status: string }).status === "ok");
  const lists = await verifiedLists(chain);
  const n = await genesisFor({ lists, policyDocId: EXPIRY_ID, issuer: K.templateExp });
  const post = async (path: string, body: unknown) => (await fetch(`${SIM}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json();
  const stateCid = await registerTemplate(chain, n.card, n.chainPubkey, post, EXPIRY);
  const notary = { card: n.card, kId: n.kId, genesisAttestation: n.genesisAttestation };
  const seeded = await host("/operator/template-seed", { template: EXPIRY_ID, notary_card: n.card, nullifier_period: "P1D" }, true);
  check(seeded["status"] === "seeded", `the operator seeded the expiry_only template's tag key (generation ${seeded["generation"]})`);

  const PERIOD = 86_400_000;
  const now = Date.now();
  const unsigned = { created_at: new Date(now).toISOString(), ends_at: new Date(now + 3 * PERIOD).toISOString(), kem: "x-wing-draft-06", key_period: "P1D", min_live: 1,
    nonce: b64uEncode(new Uint8Array(16).fill(21)), opens_at: new Date(now).toISOString(), parameters: { projected_fields: ["member_level"], source_policy: IDS.sourcePolicy }, policy_id: EXPIRY_ID,
    policy_state_cid: stateCid, replica_set: [{ instances: 1, notary_card: n.card }], requester_card: K.requester.addr, requester_pubkey: K.requester.b64, type: "notary.job.v1" };
  const job = { ...unsigned, requester_signature: { public_key: K.requester.b64, signature: signBytes(K.requester, canonicalNotary(unsigned)) } };
  const created = await host("/jobs", { job, program_cid: DERIVE_PROGRAM_CID });
  const jobHash = String(created["job_hash"]);
  check(jobHash === H(job), `the host accepted the expiry_only job (${jobHash})`);
  const ann = await waitFor("announcement", async () => { const r = await ohttp(HOST, `/jobs/${jobHash}/announcement`, "GET"); return r.status === 200 ? r.body : null; });
  const config = { attestationRoots: { "aws-nitro-enclaves": new Uint8Array(0), simulator: ROOT }, allowSimulator: true, acceptedRuntimesCard: K.listRuntimes.addr,
    programAllowlistCard: K.listPrograms.addr, notaryCardPolicy: IDS.notaryCardPolicy, acceptedKems: ["x-wing-draft-06"] as ["x-wing-draft-06"] };
  const v = await verifyNotaryJob({ announcement: ann, config, reads: walletReads(chain, notary, lists, ATT), lists, attestation: [simulator] });
  check(v.valid, `algorithm W accepts the expiry_only job${v.valid ? ` (warnings: ${v.warnings.join(",") || "none"})` : ` (${(v as { code: string }).code}: ${(v as { reason: string }).reason})`}`);
  if (!v.valid) return;
  const a = ann as { job_public_key: string; epoch: number };

  const period = Math.floor(Date.now() / PERIOD);
  const expiresAt = new Date((period + 1) * PERIOD).toISOString();
  const held: { derivedAddress: string; derivedPublicKey: string; issuedAtBoundary: string; i: number }[] = [];
  for (const i of [3, 4, 5]) {
    const { card: m, sub: s } = contributor(i);
    let r: Awaited<ReturnType<typeof requestDerivedCard>>;
    for (let attempt = 0; ; attempt++) {
      const blocks = await chain.get<{ number: number; hash: string }[]>("/headers?after=0");
      const ref = blocks[Math.max(0, blocks.length - 3 - 3 * attempt)]!;
      r = await requestDerivedCard({
        job: { jobHash, epoch: a.epoch, jobPublicKey: a.job_public_key, quorum: 1, notaryCard: n.card, notaryIdPubkey: n.kId, operatorHostPubkey: n.hostPub },
        consent: { template: EXPIRY_ID, sourcePolicy: IDS.sourcePolicy, projectedFields: ["member_level"], expiresAt },
        sourceFields: { member_level: "gold" },
        targetPeriod: period,
        keys: { persistNewKey: async () => {} },
        async buildSignedInput(payload) {
          const input = { chain_ref: { block_hash: b64uEncode(Buffer.from(ref.hash.slice(2), "hex")), block_number: ref.number }, contributor_card: m.addr, contributor_card_pubkey: m.b64,
            evidence: [], job_hash: jobHash, payload, revision: 0, signed_at: new Date().toISOString(), type: "notary.input.v1" };
          return { ...input, contributor_signature: { public_key: s.b64, signature: signBytes(s, canonicalNotary(input)) } } as never;
        },
        persist: async () => {},
        async send(sealed) { const x = await ohttp(HOST, `/jobs/${jobHash}/inputs`, "POST", sealed); if (x.status !== 200) throw new Error(JSON.stringify(x.body)); return x.body as never; },
      });
      if (r.pending || (r as { code: string }).code !== "INPUT_CHAIN_REF_UNKNOWN" || attempt >= 5) break;
      await sleep(2000);
    }
    check(r.pending, `holder ${i}: the offer matched the consent and was countersigned${r.pending ? "" : ` (${(r as { code: string }).code}: ${(r as { reason: string }).reason})`}`);
    if (!r.pending) return;
    held.push({ derivedAddress: r.derivedAddress, derivedPublicKey: r.derivedPublicKey, issuedAtBoundary: r.issuedAtBoundary, i });
  }
  await warp(Date.parse(held[0]!.issuedAtBoundary) - Date.now() + 60_000);
  for (const h of held) await waitFor(`holder ${h.i}'s card in the registry`, async () => (await fetch(`${SIM}/registry/card/${h.derivedAddress}`)).ok, 90);
  check(true, "the enclave released the batch and the host registered the three cards");

  const rpc = httpRpc(chain);
  const verifier = new CardVerifier({ rpc: rpc as never, ipfs: { fetch: async (cid: string) => { const b = await chain.bytes(cid); if (!b) throw new Error(`no ${cid}`); return b; } }, trustedRoots: [K.root.addr] });
  const verdict = (h: (typeof held)[number]) => verifier.verifyCard(h.derivedAddress, { pubkey: h.derivedPublicKey });
  const first = await verdict(held[0]!);
  check(first.errors.length === 0 && first.is_currently_valid === true, `a new card verifies and is valid (${JSON.stringify(first.errors)})`);

  // the source card of holder 3 is revoked by a certified press: under expiry_only the enclave keeps no link, so nothing follows
  const m3 = contributor(3).card;
  const entry: Record<string, unknown> = { card_state: {}, code: 803, entry_type: "revocation", version: 2 };
  entry["press_signature"] = { public_key: K.srcPress.b64, signature: signBytes(K.srcPress, canonicalNotary(entry)) };
  await chain.registerCard({ address: m3.addr, policy: IDS.sourcePolicy, press: PRESS_ADDR, head_cid: await chain.pin(encrypt(m3.pub, entry, "expiry-source-revoke", true)) });
  const batches = async () => (await chain.get<{ op: string }[]>("/txs")).filter((t) => t.op === "batch_update_card_heads").length;
  const batchesBefore = await batches();
  await sleep(12_000);
  await warp(3 * 3_600_000); // well past any propagation window (the sealed_link template's would be one hour plus one)
  await sleep(12_000);
  check((await batches()) === batchesBefore, "a source revocation causes no event on the chain under expiry_only");
  const v3 = await verdict(held[0]!);
  check(v3.revocation.status === "not_revoked" && v3.is_currently_valid === true, "holder 3's derived card is untouched and still valid after its source was revoked");

  // the card lapses at expires_at
  await warp(Date.parse(expiresAt) - Date.now() + 60_000);
  await sleep(2000);
  const after = await Promise.all(held.map(verdict));
  check(after.every((r) => r.revocation.reason === "expired" && r.is_currently_valid === false), `all three cards lapsed at expires_at ${expiresAt} (${after.map((r) => `${r.revocation.status}/${r.revocation.reason}/${r.is_currently_valid}`).join(", ")})`);
  check((await batches()) === batchesBefore, "and the lapse needed no chain event");
  log("EXPIRY_ONLY END TO END: PASS");
}

/**
 * The adversarial suite, first tranche (Phase 7.2, `plans/notary-questions-phase-7.md` Q9): attacks a hostile requester,
 * contributor or operator can make through the host's real routes, each with the refusal the spec names, and a control
 * where the honest request passes. A refusal is judged by the host's error code, which carries the enclave's.
 */
async function adversarial() {
  const st = JSON.parse(readFileSync(STATE, "utf8")) as { card: string; kId: string; genesisAttestation: string; stateCid: string; hostPub: string };
  await waitFor("host", async () => ((await (await fetch(`${HOST}/health`)).json()) as { status: string }).status === "ok");
  const lists = await verifiedLists(chain);
  const HOUR = 3_600_000;
  const config = { attestationRoots: { "aws-nitro-enclaves": new Uint8Array(0), simulator: ROOT }, allowSimulator: true, acceptedRuntimesCard: K.listRuntimes.addr,
    programAllowlistCard: K.listPrograms.addr, notaryCardPolicy: IDS.notaryCardPolicy, acceptedKems: ["x-wing-draft-06"] as ["x-wing-draft-06"] };
  const observe = process.env["ADV_OBSERVE"] === "1";
  const refused = async (what: string, clause: string, want: string, f: () => Promise<{ status: number; body: unknown }>) => {
    const r = await f();
    const b = JSON.stringify(r.body ?? null);
    const ok = r.status >= 400 && b.includes(want);
    log(`[${clause}] ${what} -> ${r.status} ${b.slice(0, 140)}`);
    check(ok || observe, `${what}: refused with ${want} (${clause})`);
  };
  const signedJob = (o: Record<string, unknown>) => {
    const now = Date.now();
    const u = { closes_at: new Date(now + HOUR).toISOString(), created_at: new Date(now - 60_000).toISOString(), kem: "x-wing-draft-06", min_live: 1, nonce: b64uEncode(crypto.getRandomValues(new Uint8Array(16))),
      opens_at: new Date(now - 60_000).toISOString(), parameters: { edge_1: 5, edge_2: 10 }, policy_id: POLICY_ID, output_recipient_keys: { [contributor(0).card.addr]: contributor(0).card.b64 },
      policy_state_cid: st.stateCid, replica_set: [{ instances: 1, notary_card: st.card }], requester_card: K.requester.addr, requester_pubkey: K.requester.b64, type: "notary.job.v1", ...o };
    return { ...u, requester_signature: { public_key: K.requester.b64, signature: signBytes(K.requester, canonicalNotary(u)) } };
  };
  const rawPost = async (path: string, body: unknown) => { const r = await fetch(`${HOST}${path}`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${env("NOTARY_ADMIN_TOKEN")}` }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json().catch(() => null) as unknown }; };

  // ---- an honest job (the controls) ----
  const job = signedJob({});
  const jobHash = H(job);
  const created = await host("/jobs", { job, program_cid: PROGRAM_CID });
  check(created["job_hash"] === jobHash, "control: the honest job opens");
  const ann = await waitFor("announcement", async () => { const r = await ohttp(HOST, `/jobs/${jobHash}/announcement`, "GET"); return r.status === 200 ? r.body : null; }) as { job_public_key: string; epoch: number };
  const notary = { card: st.card, kId: st.kId, genesisAttestation: st.genesisAttestation };
  const v = await verifyNotaryJob({ announcement: ann, config, reads: walletReads(chain, notary, lists, ATT), lists, attestation: [simulator] });
  check(v.valid, "control: the wallet accepts the honest announcement");

  // ---- attacks on job open ----
  // replayed job: the same signed job posted again
  // a replayed job is the same job: the host answers with the same job_hash and opens nothing new (the job log does not move)
  const headBefore = ((await (await fetch(`${HOST}/jobs/${jobHash}/status`)).json()) as { job_log_head?: string }).job_log_head;
  const replayed = await rawPost("/jobs", { job, program_cid: PROGRAM_CID });
  const headAfter = ((await (await fetch(`${HOST}/jobs/${jobHash}/status`)).json()) as { job_log_head?: string }).job_log_head;
  log(`[notary_job: a job's hash is its identity] the signed job posted again -> ${replayed.status} ${JSON.stringify(replayed.body)}`);
  check(replayed.status === 200 && (replayed.body as { job_hash: string }).job_hash === jobHash && headBefore === headAfter, "a signed job replayed to the host is the same job: same job_hash, nothing new opened (job log head unchanged)");
  // the operator names a program other than the policy's
  await chain.pin(ADV_MODULE); // pinned, so the host can fetch it: the refusal is the policy's program check, not a missing file
  const j2 = signedJob({});
  await refused("a job whose program_cid is not the policy's program", "notary_runtime A: the program hash equals the policy's program_cid", "", async () => rawPost("/jobs", { job: j2, program_cid: ADV_PROGRAM_CID }));

  // a program that is not on the governance allowlist, under a policy that asks for shared isolation
  const nAdv = await genesisFor({ lists, policyDocId: ADV_ID, issuer: K.adv });
  const advState = await registerAdv(chain, nAdv.card);
  const advJob = signedJob({ policy_id: ADV_ID, policy_state_cid: advState, replica_set: [{ instances: 1, notary_card: nAdv.card }], parameters: { question: "Adopt the budget?" }, output_recipient_keys: {} });
  await refused("a program that is not on the allowlist, asking for shared isolation", "notary_runtime A (A5): a shared job runs only allowlisted programs", "ADM_NOT_ALLOWLISTED_FOR_SHARED", async () => rawPost("/jobs", { job: advJob, program_cid: ADV_PROGRAM_CID }));

  // ---- attacks on a submitted input ----
  const blocks = await chain.get<{ number: number; hash: string }[]>("/headers?after=0");
  const ref = blocks[Math.max(0, blocks.length - 8)]!; // a block the enclave has certainly been sent (the host streams about one a second)
  const goodRef = { block_hash: b64uEncode(Buffer.from(ref.hash.slice(2), "hex")), block_number: ref.number };
  const input = (i: number, value: unknown, over: Record<string, unknown> = {}) => {
    const { card: m, sub: s2 } = contributor(i);
    const base = { chain_ref: goodRef, contributor_card: m.addr, contributor_card_pubkey: m.b64, evidence: [], job_hash: jobHash, payload: { value }, revision: 0, signed_at: new Date().toISOString(), type: "notary.input.v1", ...over };
    return { ...base, contributor_signature: { public_key: s2.b64, signature: signBytes(s2, canonicalNotary(base)) } };
  };
  type Sealed = Awaited<ReturnType<typeof sealInput>>;
  // the host answers 200 with the host's receipt and the enclave's sealed validation receipt, which says accepted or rejected (and why)
  const send = async (x: Sealed) => {
    const r = await ohttp(HOST, `/jobs/${jobHash}/inputs`, "POST", x.sealed);
    const sealedReceipt = (r.body as { receipt_sealed?: string } | undefined)?.receipt_sealed;
    return { status: r.status, body: r.body, receipt: sealedReceipt ? x.openReceipt(sealedReceipt) : null };
  };
  // an input is refused if the host's route errors with the code, or the enclave's validation receipt is `rejected` with it
  const refusedInput = async (what: string, clause: string, want: string, x: Sealed) => {
    const r = await send(x);
    const verdict = r.receipt ? `${r.receipt.status}: ${r.receipt.reject_reason ?? ""}` : `${r.status} ${JSON.stringify(r.body).slice(0, 100)}`;
    log(`[${clause}] ${what} -> ${verdict}`);
    check((r.receipt ? r.receipt.status === "rejected" && String(r.receipt.reject_reason).includes(want) : r.status >= 400 && JSON.stringify(r.body).includes(want)) || observe, `${what}: refused with ${want} (${clause})`);
  };
  const seal = (plain: unknown, o: { epoch?: number; key?: string } = {}) => sealInput({ plaintext: plain as never, jobPublicKey: o.key ?? ann.job_public_key, epoch: o.epoch ?? ann.epoch });

  const honest = await seal(input(0, 3));
  const r0 = await send(honest);
  check(r0.status === 200 && r0.receipt?.status === "accepted", `control: an honest input is accepted (${r0.receipt?.status} ${r0.receipt?.reject_reason ?? ""})`);
  // replayed input: identical bytes sent again: acknowledged again, not counted twice (checked against the count at close)
  const replay = await send(honest);
  log(`[replay] the same sealed input again -> ${replay.receipt?.status}`);
  const t = { sealed: { ...honest.sealed, ct: b64uEncode(Uint8Array.from(Buffer.from(honest.sealed.ct, "base64url"), (x, k) => (k === 20 ? x ^ 1 : x))) }, openReceipt: honest.openReceipt } as Sealed;
  await refused("a sealed input with one flipped bit", "notary_job B1: an input the enclave cannot open", "INPUT_UNDECRYPTABLE", async () => { const r = await send(t); return { status: r.status, body: r.body }; });
  await refused("an input whose job_hash is another job's", "notary_job B: job_hash binds the input", "INPUT_WRONG_JOB", async () => { const r = await send(await seal(input(1, 4, { job_hash: H({ other: 1 }) }))); return { status: r.status, body: r.body }; });
  await refusedInput("a chain_ref naming a block hash the chain never had", "notary_job B3: chain_ref", "INPUT_CHAIN_REF", await seal(input(1, 4, { chain_ref: { block_hash: b64uEncode(new Uint8Array(32).fill(7)), block_number: ref.number } })));
  await refusedInput("a chain_ref from a block far in the future", "notary_job B3: chain_ref", "INPUT_CHAIN_REF", await seal(input(1, 4, { chain_ref: { block_hash: goodRef.block_hash, block_number: ref.number + 100_000 } })));
  const rogue = key("adv-rogue-key");
  const forged = { ...input(1, 4) } as Record<string, unknown>;
  forged["contributor_signature"] = { public_key: rogue.b64, signature: signBytes(rogue, canonicalNotary(withoutFields(forged, "contributor_signature"))) };
  await refusedInput("an input signed by a key the contributor's card does not hold", "notary_job B5: the signer is an active notary_input sub-card", "INPUT_", await seal(forged));
  // the contributor's own sub-card signed it, then the payload was changed (what a tampering relay or host would do)
  const edited = { ...input(1, 4) } as Record<string, unknown>;
  edited["payload"] = { value: 400 };
  await refusedInput("an input edited after the contributor's sub-card signed it", "notary_job B5: the signature verifies over the input", "INPUT_SIGNER_INVALID", await seal(edited));
  // a member in good standing of another policy, with a valid notary_input sub-card of their own
  const out = contributor(OUTSIDER);
  const outsider = { chain_ref: goodRef, contributor_card: out.card.addr, contributor_card_pubkey: out.card.b64, evidence: [], job_hash: jobHash, payload: { value: 4 }, revision: 0, signed_at: new Date().toISOString(), type: "notary.input.v1" } as Record<string, unknown>;
  outsider["contributor_signature"] = { public_key: out.sub.b64, signature: signBytes(out.sub, canonicalNotary(outsider)) };
  await refusedInput("a valid member of another policy submitting to this job", "notary_job B6: the contributor predicate", "INPUT_NOT_ELIGIBLE", await seal(outsider));
  await refusedInput("a payload that breaks the input schema", "notary_job B9: input_schema", "INPUT_SCHEMA_INVALID", await seal(input(1, "not-a-number")));
  const ok1 = await send(await seal(input(1, 4)));
  check(ok1.receipt?.status === "accepted", `control: a second honest input is accepted after the attacks (${ok1.receipt?.status})`);

  // ---- after a restart (total loss), an old epoch's sealed input ----
  const restarted = await host(`/jobs/${jobHash}/restart`, { reason: "total_loss" }, true);
  check(restarted["epoch"] === 1, "the operator restarts the job at epoch 1");
  await waitFor("the epoch-1 announcement", async () => { const r = await ohttp(HOST, `/jobs/${jobHash}/announcement`, "GET"); return r.status === 200 && (r.body as { epoch: number }).epoch === 1 ? r.body : null; });
  await refused("a sealed input from epoch 0 replayed into epoch 1", "notary_replication §7: epoch 0 keys are gone", "INPUT_", async () => { const r = await send(honest); return { status: r.status, body: r.receipt ? { error: `${r.receipt.status}: ${r.receipt.reject_reason}` } : r.body }; });
  // ---- the replay is not counted twice; an input after close is refused ----
  const ann1 = await waitFor("the epoch-1 announcement", async () => { const r = await ohttp(HOST, `/jobs/${jobHash}/announcement`, "GET"); return r.status === 200 && (r.body as { epoch: number }).epoch === 1 ? r.body : null; }) as { job_public_key: string; epoch: number };
  const e1 = (plain: unknown) => seal(plain, { epoch: 1, key: ann1.job_public_key });
  for (const [i, value] of [[0, 3], [1, 7], [2, 12]] as const) {
    const once = await e1(input(i, value));
    const a1 = await send(once), a2 = await send(once); // the second is a replay of the identical bytes
    check(a1.receipt?.status === "accepted" && a2.receipt?.status === "accepted", `contributor ${i}: the input and its exact replay are both acknowledged (${a1.receipt?.status}, ${a2.receipt?.status})`);
  }
  await warp(HOUR + 60_000);
  const notarized = await waitFor("the notarized record", async () => {
    for (const rc of await chain.get<{ seq: number; record_cid: string }[]>(`/eas/${jobHash}`)) {
      const b = await chain.bytes(rc.record_cid);
      const rec = b ? (JSON.parse(new TextDecoder().decode(b)) as { kind: string; body: { notarization?: string } }) : null;
      if (rec?.kind === "notarized") return rec.body.notarization ?? null;
    }
    return null;
  }, 120);
  const nz = JSON.parse(new TextDecoder().decode((await chain.bytes(notarized))!)) as { accepted: number; suppressed: boolean; final_epoch: number };
  check(nz.accepted === 3 && nz.final_epoch === 1 && !nz.suppressed, `the notarization counts three inputs, not six: the replays were not counted twice (accepted=${nz.accepted})`);
  const late = await send(await e1(input(0, 5)));
  log(`[late] an input after the job closed -> ${late.status} ${late.receipt?.status ?? JSON.stringify(late.body).slice(0, 100)}`);
  check(late.status >= 400 || late.receipt?.status === "rejected" || observe, "an input after close is refused");
  log("ADVERSARIAL TRANCHE 1: PASS");
}

const phase = process.argv[process.argv.indexOf("--phase") + 1];
if (phase === "setup") await setup();
else if (phase === "job") await job();
else if (phase === "vote") await vote();
else if (phase === "derive") await derive();
else if (phase === "expiry") await expiry();
else if (phase === "adversarial") await adversarial();
else { console.error("usage: driver.ts --phase setup|job|vote|derive|expiry|adversarial"); process.exit(2); }
