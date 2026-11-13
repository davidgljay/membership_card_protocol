/**
 * What a wallet and a verifier read, over the simulated chain (step 5.5). These stand where the Phase 7 adapters
 * over `CardVerifier` and the RPC provider will stand: every read here is from the chain and IPFS, never from the
 * notary host. The OHTTP client plays the relay's position by posting the outer envelope to the host's gateway.
 */
import { AeadId, CipherSuite, KdfId, KemId } from "hpke-js";
import { gcm } from "@noble/ciphers/aes.js";
import { readPolicy, verifyListApproval, makeKeyExposureRead, b64uDecode, H } from "@membership-card-protocol/verifier/notary";
import type { AcceptedRuntime, CardWorld, NotarizationReads } from "@membership-card-protocol/verifier/notary";
import type { NotaryChainReads, VerifiedLists } from "@membership-card-protocol/wallet-sdk/notary";
import { K, IDS, POLICY_ID, SIM_PCR0, members, contentKey } from "./world.ts";
import { createDecipheriv } from "node:crypto";

type Json = Record<string, unknown>;
export type Chain = { get<T>(path: string): Promise<T>; bytes(cid: string): Promise<Uint8Array | null> };

export function decrypt(pub: Uint8Array, bytes: Uint8Array): Json {
  const d = createDecipheriv("aes-256-gcm", contentKey(pub), bytes.subarray(0, 12));
  d.setAuthTag(bytes.subarray(bytes.length - 16));
  return JSON.parse(Buffer.concat([d.update(bytes.subarray(12, bytes.length - 16)), d.final()]).toString()) as Json;
}

const nowIso = () => new Date().toISOString();

/** Algorithm L over the two list cards, as read from the chain (one version each in this world). */
export async function verifiedLists(chain: Chain): Promise<VerifiedLists & { ok: boolean; codes: string[] }> {
  const read = async (k: typeof K.listRuntimes, field: "accepted_runtimes" | "program_allowlist") => {
    const c = await chain.get<{ events: { cid: string }[] }>(`/registry/card/${k.addr}`);
    const history = [];
    for (const e of c.events) {
      const doc = decrypt(k.pub, (await chain.bytes(e.cid))!);
      history.push({ value: doc[field], approvalText: String(doc["list_approval"]) });
    }
    return verifyListApproval({ list: field, listCard: k.addr, history, keyset: { keys: members.map((m) => m.xy), quorum: 4, version: 1, key_scheme: 0 } as never });
  };
  const rt = await read(K.listRuntimes, "accepted_runtimes");
  const pr = await read(K.listPrograms, "program_allowlist");
  const codes = [rt, pr].filter((r) => !r.ok).map((r) => (r as { code: string }).code);
  return {
    ok: rt.ok && pr.ok, codes,
    acceptedRuntimes: rt.ok ? (rt.list as AcceptedRuntime[]) : [],
    programAllowlist: pr.ok ? (pr.list as never[]) : [],
    ...(pr.ok ? { singleOperatorQuorums: pr.singleOperatorQuorums } : {}),
  };
}

/** The notary card as registered (encrypted under its K_id), plus what a reader derives from it. */
export async function notaryCardDoc(chain: Chain, address: string, kIdB64: string): Promise<Json | null> {
  try {
    const c = await chain.get<{ head_cid: string }>(`/registry/card/${address}`);
    return decrypt(b64uDecode(kIdB64), (await chain.bytes(c.head_cid))!);
  } catch { return null; }
}

export function walletReads(chain: Chain, notary: { card: string; kId: string; genesisAttestation: string }, lists: VerifiedLists): NotaryChainReads {
  const world = () => chain.get<CardWorld>("/world");
  const exposure = makeKeyExposureRead({
    reads: { anchors: (card) => chain.get(`/eas/${card}`), fetch: (cid) => chain.bytes(cid) },
    accepted: lists.acceptedRuntimes,
    // the genesis PCR0 is the simulator runtime's (the attestation itself is checked by algorithm G at genesis)
    card: async (p) => (p === notary.card ? { kIdPubkey: notary.kId, genesisPcr0: b64uDecode(SIM_PCR0, 48), genesisAttestation: notary.genesisAttestation } : null),
  });
  return {
    nowMs: () => Date.now(),
    async policy(policyId) {
      const w = await world();
      const head = w.cards[K.policy.addr];
      if (!head) return null;
      const r = await readPolicy({ policyId, stateCid: head.log_head_cid, replicaCards: [], world: w, config: { trustedRoots: [K.root.addr], nowIso: nowIso() } });
      if (!r.ok) return null;
      return { headCid: head.log_head_cid, stateCids: head.events.map((e) => e.cid), notary: r.notary as never, approvedNotaries: r.approvedNotaries };
    },
    async policyAtState(policyId, stateCid) {
      const r = await readPolicy({ policyId, stateCid, replicaCards: [], world: await world(), config: { trustedRoots: [K.root.addr], nowIso: nowIso() } });
      return r.ok ? { notary: r.notary as never, approvedNotaries: r.approvedNotaries } : null;
    },
    satisfies: async () => true,
    async notaryCard(pointer) {
      if (pointer !== notary.card) return null;
      const d = await notaryCardDoc(chain, pointer, notary.kId);
      if (!d) return null;
      // E11: the card's issuer_card names the policy card; a reader resolves it to the policy CID
      const issuer = d["issuer_card"] === K.policy.addr ? POLICY_ID : String(d["issuer_card"]);
      return { policy_id: String(d["policy_id"]), issuer_card: issuer, platform: String(d["platform"]), revoked: false, recipient_pubkey: String(d["recipient_pubkey"]), operator_card: String(d["operator_card"]) };
    },
    async keyExposed(pointer, atMs) { const r = await exposure(pointer, atMs); return r !== "none" && r !== "later"; },
    async fetchAttestation(cid) { const b = await chain.bytes(cid); if (!b) throw new Error(`attestation ${cid} not on IPFS`); return b; },
  };
}

export function notarizationReads(chain: Chain, notary: { card: string; kId: string; genesisAttestation: string }, lists: VerifiedLists): NotarizationReads {
  const w = walletReads(chain, notary, lists);
  const exposure = makeKeyExposureRead({
    reads: { anchors: (card) => chain.get(`/eas/${card}`), fetch: (cid) => chain.bytes(cid) },
    accepted: lists.acceptedRuntimes,
    card: async (p) => (p === notary.card ? { kIdPubkey: notary.kId, genesisPcr0: b64uDecode(SIM_PCR0, 48), genesisAttestation: notary.genesisAttestation } : null),
  });
  return {
    nowMs: () => Date.now(),
    fetch: (cid) => chain.bytes(cid),
    async policyAt(policyId, stateCid) { const r = await w.policyAtState(policyId, stateCid); return r ? { ...r, chainValid: true } : null; },
    async notaryCard(pointer) { const c = await w.notaryCard(pointer); return c ? { recipientPubkey: c.recipient_pubkey, chainValid: true, operatorCard: c.operator_card } : null; },
    // `chain_state` carries the block hash as base64url
    async block(n) { try { const b = await chain.get<{ hash: string; timestamp: number }>(`/block/${n}`); return { hash: Buffer.from(b.hash.slice(2), "hex").toString("base64url"), timestampMs: b.timestamp * 1000 }; } catch { return null; } },
    keyExposure: exposure,
    anchors: (scope) => chain.get(`/eas/${scope}`),
  };
}

// ---- OHTTP client (oblivious_transport.md; the host's gateway is `notary/host/src/ohttp-gateway.ts`) ----------------

const SUITE = new CipherSuite({ kem: KemId.DhkemX25519HkdfSha256, kdf: KdfId.HkdfSha256, aead: AeadId.Aes256Gcm });
const RESPONSE_KEY_INFO = new TextEncoder().encode("card-protocol-ohttp-response-v1");
const ab = (b: Uint8Array) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;

export async function ohttp(hostUrl: string, path: string, method: "GET" | "POST", body?: unknown): Promise<{ status: number; body: unknown }> {
  const cfg = (await (await fetch(`${hostUrl}/ohttp/key-config`)).json()) as { publicKey: string };
  const pk = await SUITE.kem.deserializePublicKey(ab(new Uint8Array(Buffer.from(cfg.publicKey, "base64url"))));
  const sender = await SUITE.createSenderContext({ recipientPublicKey: pk });
  const envelope = { path, method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: Buffer.from(JSON.stringify(body)).toString("base64url") }) };
  const ct = new Uint8Array(await sender.seal(ab(new TextEncoder().encode(JSON.stringify(envelope)))));
  const responseKey = new Uint8Array(await sender.export(ab(RESPONSE_KEY_INFO), 32));
  const r = await fetch(`${hostUrl}/ohttp/gateway`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ enc: Buffer.from(sender.enc).toString("base64url"), ciphertext: Buffer.from(ct).toString("base64url") }) });
  const enc = (await r.json()) as { nonce?: string; ciphertext?: string; error?: string };
  if (!enc.nonce || !enc.ciphertext) throw new Error(`gateway: ${r.status} ${JSON.stringify(enc)}`);
  const plain = gcm(responseKey, new Uint8Array(Buffer.from(enc.nonce, "base64url"))).decrypt(new Uint8Array(Buffer.from(enc.ciphertext, "base64url")));
  const resp = JSON.parse(new TextDecoder().decode(plain)) as { status: number; body?: string };
  return { status: resp.status, body: resp.body ? JSON.parse(Buffer.from(resp.body, "base64url").toString()) : undefined };
}

void IDS; void H;
