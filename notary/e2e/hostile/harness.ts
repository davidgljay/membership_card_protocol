/**
 * The hostile-host harness (Phase 7.2, tranche 2). The operator controls everything around the enclave: what the host
 * stores, which chain it reports, which objects it serves. So the host's real handlers and schedulers run here, in the
 * test process, with services the test can make hostile, talking to a real `notary-runtime` broker. Nothing in the host or
 * the enclave is changed or switched off for a test: only what a hostile operator could change is.
 */
import { ml_dsa44 } from "@noble/post-quantum/ml-dsa.js";
import { simulator } from "@membership-card-protocol/notary-attestation";
import { verifyGenesis, b64uDecode, b64uEncode, canonicalNotary, cidOfBytes, withoutFields, GENESIS_MAX_AGE_HOLDER_MS } from "@membership-card-protocol/verifier/notary";
import { canonicalize } from "@membership-card-protocol/verifier";
import { createContext } from "../../host/src/context.js";
import type { HostContext } from "../../host/src/context.js";
import { createInMemoryKv } from "../../host/src/kv.js";
import { connectSocket, EnclaveSession } from "../../host/src/enclave/transport.js";
import { attachEnclave } from "../../host/src/handlers/enclave-requests.js";
import { handleGenesis, handleCountersign } from "../../host/src/handlers/admin.js";
import { startSchedulers } from "../../host/src/schedulers/index.js";
import { simChain } from "../../host/src/sim/index.js";
import type { ChainFeed } from "../../host/src/services.js";
import { K, IDS, PRESS_ADDR, encrypt, httpChain, signBytes } from "../src/world.ts";
import { verifiedLists } from "../src/reads.ts";
import { sha256 } from "@noble/hashes/sha256";

export const SIM = process.env["SIM_CHAIN_URL"] ?? "http://127.0.0.1:8745";
export const TOKEN = process.env["NOTARY_ADMIN_TOKEN"] ?? "e2e-admin-token-for-the-simulator-only-000";
const HOST_SEED = process.env["NOTARY_HOST_MLDSA44_PRIVATE_KEY"] ?? "ZTJlLWhvc3Qta2V5LXNlZWQtMzItYnl0ZXMtLS0tLS0";
export const ROOT = b64uDecode(process.env["ATTESTATION_ROOT"]!);
export const attestCfg = { roots: { simulator: ROOT }, allowSimulator: true };
export const chain = httpChain(SIM);
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function waitFor<T>(what: string, f: () => Promise<T | null | undefined | false>, seconds = 60): Promise<T> {
  for (let i = 0; i < seconds * 2; i++) { try { const v = await f(); if (v) return v; } catch { /* retry */ } await sleep(500); }
  throw new Error(`timed out waiting for ${what}`);
}

/** The honest chain feed, or a hostile one built from it. */
export type FeedWrapper = (honest: ChainFeed) => ChainFeed;

export interface Host {
  ctx: HostContext;
  session: EnclaveSession;
  alerts: { level: string; code: string }[];
  /** The instance IDs of the attached enclaves, in order. */
  instances: string[];
  stop(): void;
}

/** A host (the real handlers and schedulers) in front of the broker at `broker` ("host:port"). */
export async function startHost(brokers: string | string[], o: { feed?: FeedWrapper } = {}): Promise<Host> {
  const list = Array.isArray(brokers) ? brokers : [brokers];
  const sim = simChain(SIM);
  const alerts: Host["alerts"] = [];
  const ctx = createContext({
    config: { NOTARY_CARD_ADDRESSES: [], NOTARY_HOST_MLDSA44_SEED: b64uDecode(HOST_SEED, 32), NOTARY_OHTTP_PRIVATE_KEY: new Uint8Array(32).fill(3), NOTARY_RELAY_TARGET_ID: "hostile",
      NOTARY_PUBLIC_BASE_URL: "http://127.0.0.1:0", PEER_HOSTS: [], NOTARY_ADMIN_TOKEN: TOKEN },
    kv: createInMemoryKv(), ipfs: sim.ipfs, eas: sim.eas, chain: sim.chain, submitter: sim.submitter, policies: sim.policies, delivery: sim.delivery,
    peers: { send: async () => {}, request: async () => ({}) }, replicas: { start: async () => {} },
    monitor: { alert: async (level, code) => { alerts.push({ level, code }); } }, sessions: new Map(), gateOnSnapshots: true,
  });
  // every enclave is attached before the schedulers start, so each gets the headers and the policy snapshots from the beginning
  let session!: EnclaveSession;
  const instanceIds: string[] = [];
  for (const [n, broker] of list.entries()) {
    const [h, p] = broker.split(":") as [string, string];
    const s = new EnclaveSession(`hostile-${n + 1}`, await connectSocket({ host: h, port: Number(p) }));
    attachEnclave(ctx, s);
    const hello = await s.call("hello", { challenge: b64uEncode(crypto.getRandomValues(new Uint8Array(32))) });
    const instance = b64uEncode(sha256(Buffer.from(String(hello["inst_pubkey"]), "base64url")));
    ctx.instances.set(instance, s);
    ctx.instanceKeys.set(instance, String(hello["inst_pubkey"]));
    ctx.sessions.set(`hostile-${n + 1}`, s);
    instanceIds.push(instance);
    if (n === 0) session = s;
  }
  await ctx.cards.load();
  const feed = o.feed ? o.feed(sim.feed) : sim.feed;
  const stop = startSchedulers(ctx, feed, { snapshotSeconds: 2, headerMs: 500, closeMs: 1000, tickMs: 1000 });
  return { ctx, session, alerts, instances: instanceIds, stop };
}

export interface NotaryInfo { card: string; kId: string; chainPubkey: string; genesisAttestation: string; hostPub: string }

/** Lifecycle Phase 0 against this host: the operator's genesis, the policy holder's algorithm G and offer, the countersign, the registered card. */
export async function genesisFor(host: Host, o: { lists: Awaited<ReturnType<typeof verifiedLists>>; policyDocId: string; issuer: typeof K.policy }): Promise<NotaryInfo> {
  const hostPub = ml_dsa44.keygen(b64uDecode(HOST_SEED, 32)).publicKey;
  const request = { chain_pubkey: "", id_pubkey: "", nonce: b64uEncode(crypto.getRandomValues(new Uint8Array(16))), operator_card: K.operator.addr,
    operator_host_pubkey: b64uEncode(hostPub), platform: "simulator", policy_id: o.policyDocId, requested_at: new Date().toISOString(), type: "notary.genesis_request.v1" };
  const g = (await handleGenesis(host.ctx, `Bearer ${TOKEN}`, { request })) as Record<string, string>;
  const att = b64uDecode(String(g["attestation"]));
  const attCid = cidOfBytes(att);
  const completed = g["request"] as unknown as Record<string, unknown>;
  const gr = await verifyGenesis({ request: completed as never, offer: { recipient_pubkey: g["id_pubkey"]!, chain_pubkey: g["chain_pubkey"]!, genesis_attestation: attCid, operator_card: K.operator.addr },
    checks: { attestationDoc: att, operatorCardValid: async (p) => !!(await chain.get(`/registry/card/${p}`)) }, cfg: attestCfg, modules: [simulator],
    acceptedRuntimes: o.lists.acceptedRuntimes, tEvalMs: Date.now(), nowMs: Date.now(), maxAgeMs: GENESIS_MAX_AGE_HOLDER_MS });
  if (!gr.ok) throw new Error(`algorithm G: ${(gr as { code: string }).code}`);
  const requestCid = cidOfBytes(canonicalNotary(completed));
  const offer: Record<string, unknown> = { chain_pubkey: g["chain_pubkey"], genesis_attestation: attCid, genesis_request: requestCid, issuer_card: o.issuer.addr,
    operator_card: K.operator.addr, operator_host_pubkey: b64uEncode(hostPub), platform: "simulator", policy_id: IDS.notaryCardPolicy, recipient_pubkey: g["id_pubkey"] };
  offer["issuer_signature"] = signBytes(o.issuer, canonicalize(offer));
  const signed = ((await handleCountersign(host.ctx, `Bearer ${TOKEN}`, { offer })) as { offer: Record<string, unknown> }).offer;
  if (!ml_dsa44.verify(b64uDecode(String(signed["holder_signature"])), canonicalNotary(withoutFields(signed, "holder_signature")), b64uDecode(String(g["id_pubkey"])))) throw new Error("countersign does not verify");
  const card = String(g["notary_card"]);
  const head = await chain.pin(encrypt(b64uDecode(String(g["id_pubkey"])), { ...signed, ancestry_pubkeys: [o.issuer.b64], issued_at: new Date().toISOString() }, `notary-card-${card}`));
  await chain.registerCard({ address: card, policy: IDS.notaryCardPolicy, press: PRESS_ADDR, head_cid: head });
  await waitFor(`identity-log seq 0 of ${card}`, async () => (await chain.get<unknown[]>(`/eas/${card}`)).length > 0);
  return { card, kId: String(g["id_pubkey"]), chainPubkey: String(g["chain_pubkey"]), genesisAttestation: attCid, hostPub: b64uEncode(hostPub) };
}

/** The `notarized` record's notarization CID for a job, if it has been anchored. */
export async function notarizationOf(jobHash: string): Promise<string | null> {
  for (const rc of await chain.get<{ seq: number; record_cid: string }[]>(`/eas/${jobHash}`)) {
    const b = await chain.bytes(rc.record_cid);
    const rec = b ? (JSON.parse(new TextDecoder().decode(b)) as { kind: string; body: { notarization?: string } }) : null;
    if (rec?.kind === "notarized") return rec.body.notarization ?? null;
  }
  return null;
}

// ---- a forked chain the hostile host feeds an enclave ----------------------------------------------------------------------

import { toRlp, numberToHex, bytesToHex, hexToBytes } from "viem";
import { keccak_256 } from "@noble/hashes/sha3";

/**
 * A chain the real one never had: same block numbers and timestamps, different contents, linked by parent hash, so the
 * enclave (which checks only hash linkage, runtime §13, limit L4) accepts it. `blocks` are the forged headers, by number.
 */
export function forkedFeed(): { wrap: FeedWrapper; blocks: Map<number, { number: number; hash: string }> } {
  const blocks = new Map<number, { number: number; hash: string; rlp: Uint8Array; timestamp: number }>();
  const z = (n: number) => bytesToHex(new Uint8Array(n));
  const forge = (real: { number: number; timestamp: number }) => {
    const prev = blocks.get(real.number - 1);
    const parent = prev ? hexToBytes(prev.hash as `0x${string}`) : keccak_256(new TextEncoder().encode("the fork's unknown parent"));
    const rlp = toRlp([bytesToHex(parent), z(32), z(20), bytesToHex(keccak_256(new TextEncoder().encode(`forged-state-${real.number}`))), z(32), z(32), z(256),
      numberToHex(1), numberToHex(real.number), numberToHex(30_000_000), "0x", numberToHex(real.timestamp), "0x", z(32), z(8)], "bytes");
    const b = { number: real.number, hash: bytesToHex(keccak_256(rlp)), rlp, timestamp: real.timestamp };
    blocks.set(real.number, b);
    return b;
  };
  const wrap: FeedWrapper = (honest) => ({
    ...honest,
    async headersAfter(n) {
      const real = await honest.headersAfter(n);
      return real.map((r) => { const b = blocks.get(r.number) ?? forge(r); return { number: b.number, header_rlp: b64uEncode(b.rlp), timestamp: b.timestamp }; });
    },
  });
  return { wrap, blocks };
}
