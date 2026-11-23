/**
 * What a wallet and a verifier read, over the simulated chain (step 5.5). These stand where the Phase 7 adapters
 * over `CardVerifier` and the RPC provider will stand: every read here is from the chain and IPFS, never from the
 * notary host. The OHTTP client plays the relay's position by posting the outer envelope to the host's gateway.
 */
import { AeadId, CipherSuite, KdfId, KemId } from "hpke-js";
import { gcm } from "@noble/ciphers/aes.js";
import { readPolicy, readNonDerivableFields, cardSatisfies, cardChainValid, verifyListApproval, makeKeyExposureRead, b64uDecode, H } from "@membership-card-protocol/verifier/notary";
import type { AcceptedRuntime, AttestationVerifier, CardWorld, NotarizationReads } from "@membership-card-protocol/verifier/notary";
import type { NotaryChainReads, VerifiedLists } from "@membership-card-protocol/wallet-sdk/notary";
import { K, IDS, POLICY_ID, TEMPLATE_ID, VOTE_ID, EXPIRY_ID, members, contentKey } from "./world.ts";
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

type NotaryInfo = { card: string; kId: string; genesisAttestation: string };
/** One notary card, or several (the three-host scenario, 6.3). */
const find = (n: NotaryInfo | NotaryInfo[], card: string) => (Array.isArray(n) ? n : [n]).find((x) => x.card === card);

/** The platform modules and trust roots a reader checks attestations against (Q6: the same ones `CardVerifier` is given). */
export type AttestEnv = { modules: AttestationVerifier[]; roots: Record<string, Uint8Array> };

/** Every key the e2e world knows, by card address: a wallet knows its own card's key (the predicate walk needs it). */
const pubkeyOf = (card: string): Uint8Array | undefined => Object.values(K).find((k) => k.addr === card)?.pub;

/**
 * Q6 (b): algorithm E's genesis PCR0, read from the genesis attestation by the platform module (G5: nothing here parses
 * the attestation). Null when the attestation is missing, or its module or root is unknown, or it does not verify.
 */
async function genesisPcr0(chain: Chain, att: AttestEnv, cid: string): Promise<Uint8Array | null> {
  const bytes = await chain.bytes(cid);
  if (!bytes) return null;
  for (const m of att.modules) {
    const root = att.roots[m.platform];
    if (!root) continue;
    const env = m.verifyEnvelope(bytes, root);
    if (env.ok) return env.measurement;
  }
  return null;
}

export function walletReads(chain: Chain, notaries: NotaryInfo | NotaryInfo[], lists: VerifiedLists, att: AttestEnv): NotaryChainReads {
  const world = () => chain.get<CardWorld>("/world");
  const exposure = makeKeyExposureRead({
    reads: { anchors: (card) => chain.get(`/eas/${card}`), fetch: (cid) => chain.bytes(cid) },
    accepted: lists.acceptedRuntimes,
    card: async (p) => {
      const x = find(notaries, p);
      const pcr0 = x ? await genesisPcr0(chain, att, x.genesisAttestation) : null;
      return x && pcr0 ? { kIdPubkey: x.kId, genesisPcr0: pcr0, genesisAttestation: x.genesisAttestation } : null;
    },
  });
  return {
    nowMs: () => Date.now(),
    // the policy's own card: the aggregate policy's, or the derive template's (Phase 7)
    async policy(policyId) {
      const w = await world();
      const head = w.cards[(policyId === TEMPLATE_ID ? K.template : policyId === VOTE_ID ? K.vote : policyId === EXPIRY_ID ? K.templateExp : K.policy).addr];
      if (!head) return null;
      const r = await readPolicy({ policyId, stateCid: head.log_head_cid, replicaCards: [], world: w, config: { trustedRoots: [K.root.addr], nowIso: nowIso() } });
      if (!r.ok) return null;
      return { headCid: head.log_head_cid, stateCids: head.events.map((e) => e.cid), notary: r.notary as never, approvedNotaries: r.approvedNotaries };
    },
    async policyAtState(policyId, stateCid) {
      const r = await readPolicy({ policyId, stateCid, replicaCards: [], world: await world(), config: { trustedRoots: [K.root.addr], nowIso: nowIso() } });
      return r.ok ? { notary: r.notary as never, approvedNotaries: r.approvedNotaries } : null;
    },
    // 6.5a (C): the source policy's current head, read from the chain through the verifier's own read (null if untrusted)
    async nonDerivableFields(sourcePolicyId) { return readNonDerivableFields({ policyId: sourcePolicyId, world: await world(), config: { trustedRoots: [K.root.addr], nowIso: nowIso() } }); },
    // Q6 (a): the predicate over the card's verified chain (Stages 3–4 through the verifier's own read); false if it can't be read
    async satisfies(predicate, card) {
      const pubkey = pubkeyOf(card);
      return pubkey ? cardSatisfies({ predicate, card, pubkey, world: await world(), config: { trustedRoots: [K.root.addr], nowIso: nowIso() } }) : false;
    },
    async notaryCard(pointer) {
      const x = find(notaries, pointer);
      if (!x) return null;
      const d = await notaryCardDoc(chain, pointer, x.kId);
      if (!d) return null;
      // E11: the card's issuer_card names the policy card; a reader resolves it to the policy CID
      const issuer = d["issuer_card"] === K.policy.addr ? POLICY_ID : d["issuer_card"] === K.template.addr ? TEMPLATE_ID : d["issuer_card"] === K.vote.addr ? VOTE_ID : d["issuer_card"] === K.templateExp.addr ? EXPIRY_ID : String(d["issuer_card"]);
      return { policy_id: String(d["policy_id"]), issuer_card: issuer, platform: String(d["platform"]), revoked: false, recipient_pubkey: String(d["recipient_pubkey"]), operator_card: String(d["operator_card"]) };
    },
    async keyExposed(pointer, atMs) { const r = await exposure(pointer, atMs); return r !== "none" && r !== "later"; },
    async fetchAttestation(cid) { const b = await chain.bytes(cid); if (!b) throw new Error(`attestation ${cid} not on IPFS`); return b; },
  };
}

export function notarizationReads(chain: Chain, notaries: NotaryInfo | NotaryInfo[], lists: VerifiedLists, att: AttestEnv): NotarizationReads {
  const w = walletReads(chain, notaries, lists, att);
  const exposure = makeKeyExposureRead({
    reads: { anchors: (card) => chain.get(`/eas/${card}`), fetch: (cid) => chain.bytes(cid) },
    accepted: lists.acceptedRuntimes,
    card: async (p) => {
      const x = find(notaries, p);
      const pcr0 = x ? await genesisPcr0(chain, att, x.genesisAttestation) : null;
      return x && pcr0 ? { kIdPubkey: x.kId, genesisPcr0: pcr0, genesisAttestation: x.genesisAttestation } : null;
    },
  });
  const cfg = () => ({ trustedRoots: [K.root.addr], nowIso: nowIso() });
  return {
    nowMs: () => Date.now(),
    fetch: (cid) => chain.bytes(cid),
    // Q6 (c): `chainValid` is the verifier's Stages 3–4 over each card, not an assumption. A policy state is valid when
    // `readPolicy` (which runs them on the policy card) accepted it; a notary card through its own key (K_id).
    async policyAt(policyId, stateCid) { const r = await w.policyAtState(policyId, stateCid); return r ? { ...r, chainValid: true } : null; },
    async notaryCard(pointer) {
      const c = await w.notaryCard(pointer);
      const x = find(notaries, pointer);
      if (!c || !x) return null;
      const chainValid = await cardChainValid({ card: pointer, pubkey: b64uDecode(x.kId, 1312), world: await chain.get<CardWorld>("/world"), config: cfg() });
      return { recipientPubkey: c.recipient_pubkey, chainValid, operatorCard: c.operator_card };
    },
    // `chain_state` carries the block hash as base64url
    async block(n) { try { const b = await chain.get<{ hash: string; timestamp: number }>(`/block/${n}`); return { hash: Buffer.from(b.hash.slice(2), "hex").toString("base64url"), timestampMs: b.timestamp * 1000 }; } catch { return null; } },
    keyExposure: exposure,
    anchors: (scope) => chain.get(`/eas/${scope}`),
    // N14a: the state is a head of the policy's own card at or before the snapshot block. Simulated registry read: the
    // policy's card address is the one the world registered with `registerPolicy`.
    async contributorPolicyState(policyId, stateCid, block) {
      if (policyId !== IDS.sourcePolicy) return false;
      const card = await chain.get<{ events: { cid: string; timestamp: string }[] }>(`/registry/card/${K.sourcePolicy.addr}`);
      const b = await chain.get<{ timestamp: number }>(`/block/${block}`);
      return card.events.some((e) => e.cid === stateCid && Date.parse(e.timestamp) <= b.timestamp * 1000);
    },
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

// ---- a verifier's reads over the simulated chain's HTTP service (Phase 7) -----------------------------------------------

/** The `RpcProvider` a `CardVerifier` reads, backed by the simulated chain's HTTP service (what Arbitrum One stands for). */
export function httpRpc(chain: Chain) {
  const policies = () => chain.get<Record<string, string>>("/registry/policies");
  const card = async (a: string) => { try { return await chain.get<{ head_cid: string; policy: string; press: string; events: { cid: string; timestamp: string }[] }>(`/registry/card/${a}`); } catch { return null; } };
  return {
    getCardEntry: async (a: string) => { const x = await card(a); return x ? { log_head_cid: x.head_cid, policy_address: (await policies())[x.policy] ?? x.policy, last_press_address: x.press, forward_to: null, exists: true } : null; },
    isPolicyAuthorizer: async (a: string) => Object.values(await policies()).includes(a),
    getPressAuthorization: async (policy: string, press: string) => { try { const p = await chain.get<{ press_public_key: string; active: boolean }>(`/registry/press/${policy}/${press}`); return { press_public_key: p.press_public_key, mldsa44_key_hash: "", active: p.active, authorized_at: "2027-01-01T00:00:00Z", revoked_at: null }; } catch { return null; } },
    getSubCardEntry: async () => null,
    getCardEventLog: async (a: string) => (await card(a))?.events ?? [],
    getEasAnnotations: async () => [],
    getGovernanceKeyset: async () => ({ keys: members.map((m) => m.xy), quorum: 4, version: 1, key_scheme: 0 as const }),
    getNotaryLogAnchors: async (a: string) => chain.get(`/eas/${a}`),
  };
}
