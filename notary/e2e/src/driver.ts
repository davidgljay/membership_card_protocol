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
import { verifyNotaryJob, submitNotaryInputWithRetry } from "@membership-card-protocol/wallet-sdk/notary";
import { canonicalize } from "@membership-card-protocol/verifier";
import { K, IDS, POLICY_ID, PROGRAM_CID, contributor, encrypt, httpChain, registerWorld, approveNotary, signBytes, PRESS_ADDR } from "./world.ts";
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
    nonce: b64uEncode(crypto.getRandomValues(new Uint8Array(16))), opens_at: new Date(now).toISOString(), parameters: {}, policy_id: POLICY_ID,
    policy_state_cid: st.stateCid, replica_set: [{ instances: 1, notary_card: st.card }], requester_card: K.requester.addr, requester_pubkey: K.requester.b64, type: "notary.job.v1" };
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

  // Phase 3: three contributors (yes, yes, no)
  const choices = ["yes", "yes", "no"];
  for (let i = 0; i < choices.length; i++) {
    const { card: m, sub: s } = contributor(i);
    const blocks = await chain.get<{ number: number; hash: string }[]>("/headers?after=0");
    const ref = blocks[Math.max(0, blocks.length - 3)]!; // a block the host has already streamed
    const r = await submitNotaryInputWithRetry({
      job: { jobHash, epoch: a.epoch, jobPublicKey: a.job_public_key, quorum: 1, notaryCard: st.card, notaryIdPubkey: st.kId, operatorHostPubkey: st.hostPub },
      async buildSignedInput() {
        const input = { chain_ref: { block_hash: b64uEncode(Buffer.from(ref.hash.slice(2), "hex")), block_number: ref.number }, contributor_card: m.addr, contributor_card_pubkey: m.b64,
          evidence: [], job_hash: jobHash, payload: { choice: choices[i] }, revision: 0, signed_at: new Date().toISOString(), type: "notary.input.v1" };
        return { ...input, contributor_signature: { public_key: s.b64, signature: signBytes(s, canonicalNotary(input)) } } as never;
      },
      persist: async () => {},
      async send(sealed) { const r = await ohttp(HOST, `/jobs/${jobHash}/inputs`, "POST", sealed); if (r.status !== 200) throw new Error(JSON.stringify(r.body)); return r.body as never; },
    });
    check(r.submitted, `contributor ${i} submitted "${choices[i]}" with a host receipt and an accepted validation receipt${r.submitted ? "" : ` (${(r as { code: string }).code}: ${(r as { reason: string }).reason})`}`);
  }

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
  const n = JSON.parse(new TextDecoder().decode((await chain.bytes(notarizationCid!))!)) as { output: unknown; accepted: number; suppressed: boolean };
  check(n.accepted === 3 && !n.suppressed, `the notarization counts 3 contributors (accepted=${n.accepted})`);
  check(JSON.stringify(n.output) === JSON.stringify({ public: { no: 1, yes: 2 } }), `the public output is the tally ${JSON.stringify(n.output)}`);
  const res = await verifyNotarization(notarizationCid!, notarizationReads(chain, notary, lists), { attest: attestCfg, modules: [simulator], acceptedRuntimes: lists.acceptedRuntimes });
  check(res.valid, `algorithm N verifies the notarization${res.valid ? ` (warnings: ${(res as { warnings: string[] }).warnings.join(",") || "none"})` : ` (${JSON.stringify(res)})`}`);
  log("END TO END: PASS");
}

const phase = process.argv[process.argv.indexOf("--phase") + 1];
if (phase === "setup") await setup();
else if (phase === "job") await job();
else { console.error("usage: driver.ts --phase setup|job"); process.exit(2); }
