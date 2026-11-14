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
import { verifyGenesis, verifyNotarization, b64uDecode, b64uEncode, canonicalNotary, cidOfBytes, withoutFields, H, GENESIS_MAX_AGE_HOLDER_MS } from "@membership-card-protocol/verifier/notary";
import { verifyNotaryJob, submitNotaryInputWithRetry, watchNotaryJobsOnce } from "@membership-card-protocol/wallet-sdk/notary";
import type { StoredNotaryInput } from "@membership-card-protocol/wallet-sdk/notary";
import { canonicalize } from "@membership-card-protocol/verifier";
import { decryptRoutingEnvelope } from "@membership-card-protocol/app-sdk";
import { K, IDS, POLICY_ID, PROGRAM_CID, contributor, kemKeypair, encrypt, httpChain, registerWorld, approveNotary, signBytes, PRESS_ADDR } from "./world.ts";
import { verifiedLists, walletReads, notarizationReads, ohttp } from "./reads.ts";

const env = (k: string, d?: string) => { const v = process.env[k] ?? d; if (v === undefined) throw new Error(`${k} is required`); return v; };
const HOST = env("HOST_URL", "http://localhost:3000").replace(/\/$/, "");
const chain = httpChain(env("SIM_CHAIN_URL", "http://localhost:8545").replace(/\/$/, ""));
const STATE = env("STATE_FILE", "e2e-state.json");
// the simulator's test root: from the environment, or the one pinned in the runtime image's pins file
const ROOT = b64uDecode(process.env["ATTESTATION_ROOT"] ?? (JSON.parse(readFileSync(new URL("../fixtures/pins.json", import.meta.url), "utf8")) as { attestation_root: string }).attestation_root);
const attestCfg = { roots: { simulator: ROOT }, allowSimulator: true };
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

async function setup() {
  await waitFor("sim-chain", () => chain.get("/time"));
  await waitFor("host", async () => ((await (await fetch(`${HOST}/health`)).json()) as { status: string }).status === "ok");
  const { policyGenesisCid } = await registerWorld(chain, 3);
  log("world registered");
  const lists = await verifiedLists(chain);
  check(lists.ok, `algorithm L accepts both governance lists (${lists.codes.join(",")})`);

  // Phase 0, steps 2–4: the operator's genesis request
  const hostPub = ml_dsa44.keygen(b64uDecode(env("NOTARY_HOST_MLDSA44_PRIVATE_KEY"), 32)).publicKey;
  const request = { chain_pubkey: "", id_pubkey: "", nonce: b64uEncode(crypto.getRandomValues(new Uint8Array(16))), operator_card: K.operator.addr,
    operator_host_pubkey: b64uEncode(hostPub), platform: "simulator", policy_id: POLICY_ID, requested_at: new Date().toISOString(), type: "notary.genesis_request.v1" };
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
  const offer: Record<string, unknown> = { chain_pubkey: g["chain_pubkey"], genesis_attestation: attCid, genesis_request: requestCid, issuer_card: K.policy.addr,
    operator_card: K.operator.addr, operator_host_pubkey: b64uEncode(hostPub), platform: "simulator", policy_id: IDS.notaryCardPolicy, recipient_pubkey: g["id_pubkey"] };
  offer["issuer_signature"] = signBytes(K.policy, canonicalize(offer));
  // step 6: countersign
  const signed = (await host("/genesis/countersign", { offer }, true))["offer"] as Record<string, unknown>;
  check(ml_dsa44.verify(b64uDecode(String(signed["holder_signature"])), canonicalNotary(withoutFields(signed, "holder_signature")), b64uDecode(String(g["id_pubkey"]))), "the enclave countersigned with K_id");
  // step 7: a press for NotaryCardPolicy registers the card (encrypted under K_id)
  const head = await chain.pin(encrypt(b64uDecode(String(g["id_pubkey"])), signed, `notary-card-${card}`));
  await chain.registerCard({ address: card, policy: IDS.notaryCardPolicy, press: PRESS_ADDR, head_cid: head });
  // step 9 (E26): identity-log seq 0, anchored
  const anchors = await waitFor("identity-log seq 0 anchor", async () => { const a = await chain.get<{ seq: number; record_cid: string }[]>(`/eas/${card}`); return a.length ? a : null; });
  check(anchors[0]!.seq === 0, "identity-log seq 0 is anchored on the chain (E26)");
  // step 8: the policy holder approves the card
  const stateCid = await approveNotary(chain, policyGenesisCid, card);
  writeFileSync(STATE, JSON.stringify({ card, kId: g["id_pubkey"], genesisAttestation: attCid, stateCid, hostPub: b64uEncode(hostPub) }, null, 2));
  log(`setup done; the host serves ${card} (created through /genesis)`);
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
  const v = await verifyNotaryJob({ announcement: ann, config, reads: walletReads(chain, notary, lists), lists, attestation: [simulator] });
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
    verify: (announcement, highestEpochSeen) => verifyNotaryJob({ announcement, config, reads: walletReads(chain, notary, lists), lists, attestation: [simulator], highestEpochSeen }),
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
  const res = await verifyNotarization(notarizationCid!, notarizationReads(chain, notary, lists), { attest: attestCfg, modules: [simulator], acceptedRuntimes: lists.acceptedRuntimes });
  check(res.valid, `algorithm N verifies the notarization${res.valid ? ` (warnings: ${(res as { warnings: string[] }).warnings.join(",") || "none"})` : ` (${JSON.stringify(res)})`}`);
  log("END TO END: PASS");
}

const phase = process.argv[process.argv.indexOf("--phase") + 1];
if (phase === "setup") await setup();
else if (phase === "job") await job();
else { console.error("usage: driver.ts --phase setup|job"); process.exit(2); }
