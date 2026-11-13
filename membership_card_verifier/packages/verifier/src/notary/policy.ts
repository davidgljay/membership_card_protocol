/**
 * Algorithm R: reading a policy and a requester (notary_lifecycle.md Appendix A.7) — the TypeScript reference for the
 * enclave's Rust port (`notary-cards::policy`), kept in step by `notary/vectors/cards/policy_cases.json`.
 *
 * Reads go through a `CardWorld` (registry entries + IPFS objects); in the enclave they come over vsock `fetch`, with no
 * network connection. Content is checked against its CID; trust comes from the pinned trusted roots.
 */
import { sha256 } from "@noble/hashes/sha256";
import { aes256gcmDecrypt, hkdfSha3256, keccak256 } from "../crypto.js";
import { verifyStage3 } from "../stages/stage3.js";
import { verifyStage4 } from "../stages/stage4.js";
import { b64uDecode, b64uEncode, canonicalNotary, digestFromCid } from "./canonical.js";
import { worldProviders } from "./contributor.js";
import type { CardWorld } from "./contributor.js";
import { evaluatePredicate } from "./predicates.js";

export interface PolicyReadConfig {
  trustedRoots: string[];
  /** Chain time (ISO 8601) for revocation. */
  nowIso: string;
  maxChainDepth?: number;
}

export type PolicyCode = "JOB_POLICY_UNTRUSTED" | "JOB_POLICY_CHANGED" | "JOB_NOTARY_NOT_APPROVED" | "JOB_REQUESTER_NOT_PERMITTED";
export type PolicyReadResult =
  | { ok: true; policyAddress: string; notary: unknown; approvedNotaries: string[] }
  | { ok: false; code: PolicyCode; detail: string };

const dec = new TextDecoder();
const fail = (code: PolicyCode, detail: string): PolicyReadResult => ({ ok: false, code, detail });

/** Bytes of a CID from the world, only if they hash to it (raw sha2-256 CIDs). */
function fetchChecked(w: CardWorld, cid: string): Uint8Array | null {
  const b64 = w.ipfs[cid];
  if (b64 === undefined) return null;
  try {
    const bytes = b64uDecode(b64);
    return b64uEncode(sha256(bytes)) === b64uEncode(digestFromCid(cid)) ? bytes : null;
  } catch { return null; }
}

function parseObject(bytes: Uint8Array): Record<string, unknown> | null {
  try {
    const v = JSON.parse(dec.decode(bytes));
    return v !== null && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch { return null; }
}

/** A document that is plain JSON, or AES-256-GCM under `key` (R1). */
async function readDoc(w: CardWorld, cid: string, key: Uint8Array): Promise<Record<string, unknown> | null> {
  const bytes = fetchChecked(w, cid);
  if (!bytes) return null;
  try { const p = parseObject(await aes256gcmDecrypt(key, bytes)); if (p) return p; } catch { /* not encrypted under key */ }
  return parseObject(bytes);
}

/** A card head: a document, or a LogEntry overlaid on its genesis (`decryptCardHead`'s rule), each plain or encrypted. */
async function readHead(w: CardWorld, cid: string, key: Uint8Array): Promise<Record<string, unknown> | null> {
  const head = await readDoc(w, cid, key);
  if (!head) return null;
  if (head["entry_type"] !== "field_update" && head["entry_type"] !== "revocation") return head;
  const genesisCid = Array.isArray(head["history"]) ? (head["history"][0] as string | undefined) : undefined;
  const genesis = genesisCid ? await readDoc(w, genesisCid, key) : {};
  if (!genesis) return null;
  const state = (head["card_state"] as Record<string, unknown> | undefined) ?? {};
  const meta: Record<string, unknown> = {};
  for (const k of ["entry_type", "code", "revocation", "history", "version", "prev_log_root"]) if (head[k] !== undefined) meta[k] = head[k];
  return { ...genesis, ...state, ...meta };
}

const same = (a: unknown, b: unknown) => {
  try { return b64uEncode(canonicalNotary(a ?? null)) === b64uEncode(canonicalNotary(b ?? null)); } catch { return JSON.stringify(a) === JSON.stringify(b); }
};

async function chainOk(w: CardWorld, doc: Record<string, unknown>, address: string, pubkey: Uint8Array, cfg: PolicyReadConfig): Promise<{ ok: true; chain: { address: string; content: Record<string, unknown> }[]; addresses: string[] } | { ok: false; detail: string }> {
  const { rpc, ipfs } = worldProviders(w);
  const s3 = await verifyStage3(doc as never, address, rpc, ipfs, { trustedRoots: cfg.trustedRoots, maxChainDepth: cfg.maxChainDepth ?? 64 }, pubkey);
  if (s3.chain_reaches_trusted_root !== true) return { ok: false, detail: s3.errors[0]?.code ?? "no trusted root" };
  const s4 = await verifyStage4(s3.chain, cfg.nowIso, rpc, { revocationFreshnessWindowSeconds: 3600, rejectStaleRevocation: false });
  if (s4.errors.some((e) => e.code === "HISTORY_MISMATCH")) return { ok: false, detail: "HISTORY_MISMATCH" };
  const r = s4.revocation;
  if ((r.status === "revoked" || r.status === "loud_revocation") && r.effective_date !== null && r.effective_date <= cfg.nowIso) return { ok: false, detail: "revoked" };
  return { ok: true, chain: s3.chain.map((l) => ({ address: l.card_address, content: l.card_content })), addresses: s3.chain_card_addresses };
}

/** R1–R4. `replicaCards` are the job's `replica_set` cards. */
export async function readPolicy(o: { policyId: string; stateCid: string; replicaCards: string[]; world: CardWorld; config: PolicyReadConfig }): Promise<PolicyReadResult> {
  const { world: w, config: cfg } = o;
  // R1: the genesis document is plain JSON; it gives the policy key and address
  const gBytes = fetchChecked(w, o.policyId);
  const genesis = gBytes ? parseObject(gBytes) : null;
  if (!genesis || typeof genesis["recipient_pubkey"] !== "string") return fail("JOB_POLICY_UNTRUSTED", "policy_id document");
  let pub: Uint8Array;
  try { pub = b64uDecode(genesis["recipient_pubkey"] as string, 1312); } catch { return fail("JOB_POLICY_UNTRUSTED", "recipient_pubkey"); }
  const key = hkdfSha3256(pub, "card-content-v1");
  const address = keccak256(pub);
  const stateDoc = await readHead(w, o.stateCid, key);
  if (!stateDoc) return fail("JOB_POLICY_UNTRUSTED", "policy_state_cid document");
  // R2: the state is in the policy's head history, and notary / approved_notaries are unchanged at the head
  const entry = w.cards[address];
  if (!entry) return fail("JOB_POLICY_UNTRUSTED", "policy not registered");
  if (!entry.events.some((e) => e.cid === o.stateCid)) return fail("JOB_POLICY_CHANGED", "policy_state_cid not in the policy's history");
  const head = await readHead(w, entry.log_head_cid, key);
  if (!head) return fail("JOB_POLICY_UNTRUSTED", "current head");
  if (!same(head["notary"], stateDoc["notary"]) || !same(head["approved_notaries"], stateDoc["approved_notaries"])) return fail("JOB_POLICY_CHANGED", "notary or approved_notaries changed");
  // R3: the policy card's chain reaches a pinned root and isn't revoked
  const c = await chainOk(w, head, address, pub, cfg);
  if (!c.ok) return fail("JOB_POLICY_UNTRUSTED", c.detail);
  // R4
  const approved = Array.isArray(head["approved_notaries"]) ? (head["approved_notaries"] as unknown[]).filter((x): x is string => typeof x === "string") : [];
  if (!o.replicaCards.every((r) => approved.includes(r))) return fail("JOB_NOTARY_NOT_APPROVED", "replica_set card not in approved_notaries");
  return { ok: true, policyAddress: address, notary: head["notary"], approvedNotaries: approved };
}

/** R5: the requester's chain satisfies `job_requester_predicate`; `is_holder` iff the requester holds the policy card. */
export async function requesterAllowed(o: { job: Record<string, unknown>; predicate: unknown; policyAddress: string; world: CardWorld; config: PolicyReadConfig }): Promise<boolean> {
  const { world: w } = o;
  let pub: Uint8Array;
  try { pub = b64uDecode(String(o.job["requester_pubkey"]), 1312); } catch { return false; }
  const card = String(o.job["requester_card"]);
  if (keccak256(pub) !== card) return false;
  const entry = w.cards[card];
  if (!entry) return false;
  const head = await readHead(w, entry.log_head_cid, hkdfSha3256(pub, "card-content-v1"));
  if (!head) return false;
  const c = await chainOk(w, head, card, pub, o.config);
  if (!c.ok) return false;
  const params = (o.job["parameters"] as Record<string, unknown> | undefined) ?? {};
  return evaluatePredicate(o.predicate, { chain: c.chain, addresses: c.addresses, parameters: params, isHolder: card === o.policyAddress });
}

