/**
 * Chain-reading helpers for card login: current card fields, a card's policy,
 * the policy issuance-chain walk (protocol-objects.md §8.1), DCQL `mcard`
 * matching, and effective `preferred_services` (§2).
 */

import { keccak256, hkdfSha3256, base64UrlToBytes, aes256gcmDecrypt } from "../crypto.js";
import { decryptCardHead } from "../head.js";
import type { RpcProvider, IpfsProvider } from "../types.js";
import type { McardCredentialQuery, PreferredService } from "./types.js";

export interface ChainContext {
  rpc: RpcProvider;
  ipfs: IpfsProvider;
  maxChainDepth?: number;
}

/** Normalizes a card address for comparison: lowercase hex, no 0x. */
export function normAddress(a: string): string {
  return a.toLowerCase().replace(/^0x/, "");
}

const decoder = new TextDecoder();

/**
 * Reads a card's current fields (genesis document overlaid with the latest
 * LogEntry's card_state — see decryptCardHead). Returns null if the card is
 * not registered or cannot be decrypted.
 */
export async function readCardFields(
  pubkeyB64: string,
  ctx: ChainContext
): Promise<{ address: string; fields: Record<string, unknown> } | null> {
  const pubkey = new Uint8Array(base64UrlToBytes(pubkeyB64));
  const address = keccak256(pubkey);
  const entry = await ctx.rpc.getCardEntry(address);
  if (!entry || !entry.exists) return null;
  try {
    const fields = await decryptCardHead(entry.log_head_cid, hkdfSha3256(pubkey, "card-content-v1"), ctx.ipfs);
    return { address, fields: fields as Record<string, unknown> };
  } catch {
    return null;
  }
}

/**
 * Reads a sub-card's document: from its SubCardEntry's sub_card_doc_cid (the
 * registry's form, pinned as plain JSON) or a CardEntry head encrypted under
 * the sub-card key. Returns null unless recipient_pubkey is this key.
 */
export async function readSubCardDocument(pubkeyB64: string, ctx: ChainContext): Promise<Record<string, unknown> | null> {
  const pubkey = new Uint8Array(base64UrlToBytes(pubkeyB64));
  const address = keccak256(pubkey);
  const entry = await ctx.rpc.getCardEntry(address);
  const cid = entry?.exists ? entry.log_head_cid : (await ctx.rpc.getSubCardEntry(address))?.sub_card_doc_cid;
  if (!cid) return null;
  try {
    const raw = await ctx.ipfs.fetch(cid);
    let text: string;
    try {
      text = decoder.decode(await aes256gcmDecrypt(hkdfSha3256(pubkey, "card-content-v1"), raw));
    } catch {
      text = decoder.decode(raw);
    }
    const doc = JSON.parse(text) as Record<string, unknown>;
    return doc["recipient_pubkey"] === pubkeyB64 ? doc : null;
  } catch {
    return null;
  }
}

export interface PolicyRef {
  /** Registry address of the policy card. */
  address: string;
  /** The policy snapshot at the card's policy_id CID (plaintext). */
  snapshot: Record<string, unknown>;
}

/** Resolves the policy a card was issued under, from its policy_id snapshot. */
export async function policyOf(cardFields: Record<string, unknown>, ctx: ChainContext): Promise<PolicyRef | null> {
  const policyId = cardFields["policy_id"];
  if (typeof policyId !== "string") return null;
  let snapshot: Record<string, unknown>;
  try {
    snapshot = JSON.parse(decoder.decode(await ctx.ipfs.fetch(policyId))) as Record<string, unknown>;
  } catch {
    return null;
  }
  const pk = snapshot["recipient_pubkey"];
  if (typeof pk !== "string") return null;
  return { address: keccak256(new Uint8Array(base64UrlToBytes(pk))), snapshot };
}

/**
 * The parent of a policy along its issuance chain: the policy card's issuer
 * (ancestry_pubkeys[0]) → that card's own policy. Null at a root.
 */
export async function parentPolicy(policy: PolicyRef, ctx: ChainContext): Promise<PolicyRef | null> {
  const ancestry = policy.snapshot["ancestry_pubkeys"];
  if (!Array.isArray(ancestry) || ancestry.length === 0) return null;
  const issuer = await readCardFields(ancestry[0] as string, ctx);
  if (!issuer) return null;
  const parent = await policyOf(issuer.fields, ctx);
  if (!parent || parent.address === policy.address) return null; // self-referential root
  return parent;
}

/** The card's policy followed by its issuance-chain ancestors, nearest first. */
export async function policyLineage(cardFields: Record<string, unknown>, ctx: ChainContext): Promise<PolicyRef[]> {
  const out: PolicyRef[] = [];
  const seen = new Set<string>();
  let current = await policyOf(cardFields, ctx);
  const maxDepth = ctx.maxChainDepth ?? 64;
  while (current && !seen.has(current.address) && out.length < maxDepth) {
    out.push(current);
    seen.add(current.address);
    current = await parentPolicy(current, ctx);
  }
  return out;
}

export type DcqlMatch =
  | { matched: true; policy: string }
  | { matched: false; reason: "NO_POLICY_MATCH" | "POLICY_UNRESOLVED" | "PREDICATE_NOT_SUPPORTED" };

/**
 * protocol-objects.md §8.1 steps 1–2 for one card. Status (step 3) is checked
 * by the caller with the full verifier. Policies compare by registry address.
 */
export async function matchMcardQuery(
  cardFields: Record<string, unknown>,
  query: McardCredentialQuery,
  ctx: ChainContext,
  /**
   * The card's own registry address. When given, its policy is the
   * `policy_address` recorded on-chain for it (authoritative), rather than one
   * derived from the policy snapshot's public key. Ancestors still come from
   * the snapshot's issuance chain.
   */
  cardAddress?: string
): Promise<DcqlMatch> {
  const lineage = await policyLineage(cardFields, ctx);
  let own = lineage[0]?.address;
  if (cardAddress) {
    const entry = await ctx.rpc.getCardEntry(normAddress(cardAddress));
    const onChain = entry?.exists && entry.policy_address ? normAddress(entry.policy_address) : "";
    if (onChain && !/^0+$/.test(onChain)) own = onChain;
  }
  if (!own) return { matched: false, reason: "POLICY_UNRESOLVED" };
  const ancestors = new Set([own, ...lineage.map((p) => p.address)]);
  for (const ref of query.meta.policies) {
    const id = normAddress(ref.id);
    if (id === own || (ref.include_children && ancestors.has(id))) {
      // The optional predicate needs the predicate engine, which lives in the
      // press today; until it is shared, a predicate never matches.
      if (query.meta.predicate !== undefined) return { matched: false, reason: "PREDICATE_NOT_SUPPORTED" };
      return { matched: true, policy: ref.id };
    }
  }
  return { matched: false, reason: "NO_POLICY_MATCH" };
}

/**
 * Reads the live head of a policy card (not the snapshot) — preferred_services
 * is discovery data and follows the live head (card_protocol_spec.md §1).
 */
export async function livePolicyFields(policy: PolicyRef, ctx: ChainContext): Promise<Record<string, unknown> | null> {
  const pk = policy.snapshot["recipient_pubkey"];
  if (typeof pk !== "string") return null;
  return (await readCardFields(pk, ctx))?.fields ?? null;
}

/**
 * Effective preferred_services (protocol-objects.md §2): the first policy up
 * the issuance chain whose live head has the field set — including [] — wins.
 */
export async function effectivePreferredServices(
  cardFields: Record<string, unknown>,
  ctx: ChainContext
): Promise<PreferredService[]> {
  for (const policy of await policyLineage(cardFields, ctx)) {
    const live = (await livePolicyFields(policy, ctx)) ?? policy.snapshot;
    const list = live["preferred_services"];
    if (Array.isArray(list)) return list as PreferredService[];
  }
  return [];
}
