/**
 * Contributor checks B5–B8 (notary_lifecycle.md Appendix B) — the TypeScript reference for the enclave's Rust port
 * (`notary-cards`, code-plan §7.5).
 *
 * Runs the verifier's real Stage 2 (signing sub-card), Stage 3 (chain to a trusted root) and Stage 4 (revocation)
 * over a `CardWorld`: the registry entries and IPFS objects the check may read. In the enclave the same world comes
 * from the input's `evidence` and the host's whole-policy snapshots; here it backs an `RpcProvider` / `IpfsProvider`.
 * Trusted roots, the app-certification root and the login-service root are pinned in the runtime image (E29).
 *
 * Outcome codes: B5 `INPUT_SIGNER_INVALID`, B6 `INPUT_BINDING_MISMATCH`, B7 `INPUT_CARD_UNTRUSTED` /
 * `INPUT_CARD_REVOKED`, B8 `INPUT_NOT_ELIGIBLE`. On success: the contributor's root-key hash (B10 dedupe) and chain.
 */
import { sha256 } from "@noble/hashes/sha256";
import { verifyStage2 } from "../stages/stage2.js";
import { verifyStage3 } from "../stages/stage3.js";
import { verifyStage4 } from "../stages/stage4.js";
import { keccak256, mlDsa44Verify } from "../crypto.js";
import type { IpfsProvider, RpcProvider } from "../types.js";
import { b64uDecode, b64uEncode, canonicalNotary, withoutFields } from "./canonical.js";
import { evaluatePredicate } from "./predicates.js";

export interface CardWorld {
  cards: Record<string, { log_head_cid: string; policy_address: string; last_press_address: string; events: { cid: string; timestamp: string }[] }>;
  subcards: Record<string, { master_card_address: string; sub_card_doc_cid: string; active: boolean }>;
  /** CID → base64url bytes. */
  ipfs: Record<string, string>;
}

export interface ContributorConfig {
  trustedRoots: string[];
  appCertificationRoot: string;
  loginServiceCertificationRoot: string;
  /** Chain time (ISO 8601) for `valid_until` and revocation effective dates. */
  nowIso: string;
  maxChainDepth?: number;
}

export type ContributorResult =
  | { ok: true; root_key_hash: string; chain_addresses: string[] }
  | { ok: false; code: ContributorCode; detail: string };

export type ContributorCode = "INPUT_SIGNER_INVALID" | "INPUT_BINDING_MISMATCH" | "INPUT_CARD_UNTRUSTED" | "INPUT_CARD_REVOKED" | "INPUT_NOT_ELIGIBLE";

export function worldProviders(w: CardWorld): { rpc: RpcProvider; ipfs: IpfsProvider } {
  const rpc: RpcProvider = {
    async getCardEntry(a) {
      const c = w.cards[a];
      return c ? { log_head_cid: c.log_head_cid, policy_address: c.policy_address, last_press_address: c.last_press_address, forward_to: null, exists: true } : null;
    },
    async isPolicyAuthorizer() { return false; }, // roots are pinned (E29): only `trustedRoots` count
    async getPressAuthorization() { return null; },
    async getSubCardEntry(a) {
      const s = w.subcards[a];
      return s ? { master_card_address: s.master_card_address, registration_log_head: "", sub_card_doc_cid: s.sub_card_doc_cid, active: s.active, registered_at: "", deregistered_at: null } : null;
    },
    async getCardEventLog(a) { return w.cards[a]?.events ?? []; },
    async getEasAnnotations() { return []; },
  };
  const ipfs: IpfsProvider = {
    async fetch(cid) {
      const b = w.ipfs[cid];
      if (b === undefined) throw new Error(`not in world: ${cid}`);
      return b64uDecode(b);
    },
  };
  return { rpc, ipfs };
}

const fail = (code: ContributorCode, detail: string): ContributorResult => ({ ok: false, code, detail });

export async function checkContributor(o: {
  input: Record<string, unknown>;
  contributorPredicate: unknown;
  parameters: Record<string, unknown>;
  world: CardWorld;
  config: ContributorConfig;
}): Promise<ContributorResult> {
  const { input, world, config } = o;
  const { rpc, ipfs } = worldProviders(world);
  const sig = input["contributor_signature"] as { public_key?: unknown; signature?: unknown } | undefined;
  let signerPk: Uint8Array;
  try {
    signerPk = b64uDecode(String(sig?.public_key), 1312);
  } catch { return fail("INPUT_SIGNER_INVALID", "contributor_signature.public_key"); }

  // B5: a valid sub-card (Stage 2), with the notary_input capability, in date, at T2, whose key signed the input.
  const s2 = await verifyStage2(signerPk, rpc, ipfs, { appCertificationRoot: config.appCertificationRoot, loginServiceCertificationRoot: config.loginServiceCertificationRoot, maxChainDepth: config.maxChainDepth ?? 64 });
  if (s2.scope_clean !== true || !s2.sub_card_doc || !s2.master_card_doc || !s2.master_card_pubkey) {
    return fail("INPUT_SIGNER_INVALID", s2.errors[0]?.code ?? "stage 2");
  }
  const sub = s2.sub_card_doc;
  if (!Array.isArray(sub.capabilities) || !sub.capabilities.includes("notary_input")) return fail("INPUT_SIGNER_INVALID", "capability");
  if (sub.valid_until !== undefined && !(Date.parse(sub.valid_until) > Date.parse(config.nowIso))) return fail("INPUT_SIGNER_INVALID", "valid_until");
  if (sub.attestation_level !== "T2") return fail("INPUT_SIGNER_INVALID", "attestation_level");
  let sigOk = false;
  try { sigOk = mlDsa44Verify(signerPk, canonicalNotary(withoutFields(input, "contributor_signature")), b64uDecode(String(sig?.signature), 2420)); } catch { sigOk = false; }
  if (!sigOk) return fail("INPUT_SIGNER_INVALID", "contributor_signature");

  // B6: keccak256(contributor_card_pubkey) == contributor_card == the sub-card's holder_primary_card
  let cpk: Uint8Array;
  try { cpk = b64uDecode(String(input["contributor_card_pubkey"]), 1312); } catch { return fail("INPUT_BINDING_MISMATCH", "contributor_card_pubkey"); }
  if (keccak256(cpk) !== input["contributor_card"] || input["contributor_card"] !== sub.holder_primary_card) return fail("INPUT_BINDING_MISMATCH", "binding");

  // B7: the master card chains to a pinned trusted root (Stage 3) and no chain card is revoked by chain time (Stage 4)
  const master = sub.holder_primary_card;
  const s3 = await verifyStage3(s2.master_card_doc, master, rpc, ipfs, { trustedRoots: config.trustedRoots, maxChainDepth: config.maxChainDepth ?? 64 }, s2.master_card_pubkey);
  if (s3.chain_reaches_trusted_root !== true) return fail("INPUT_CARD_UNTRUSTED", s3.errors[0]?.code ?? "no trusted root");
  const s4 = await verifyStage4(s3.chain, config.nowIso, rpc, { revocationFreshnessWindowSeconds: 3600, rejectStaleRevocation: false });
  if (s4.errors.some((e) => e.code === "HISTORY_MISMATCH")) return fail("INPUT_CARD_UNTRUSTED", "HISTORY_MISMATCH");
  const r = s4.revocation;
  if ((r.status === "revoked" || r.status === "loud_revocation") && r.effective_date !== null && r.effective_date <= config.nowIso) {
    return fail("INPUT_CARD_REVOKED", `${r.status} ${r.code ?? r.reason ?? ""}`);
  }
  if (r.status === "unknown") return fail("INPUT_CARD_UNTRUSTED", "revocation unknown");

  // B8: contributor_predicate over the master card's chain, parameter references resolved
  const ctx = {
    chain: s3.chain.map((l) => ({ address: l.card_address, content: l.card_content })),
    addresses: s3.chain_card_addresses,
    parameters: o.parameters,
  };
  if (!evaluatePredicate(o.contributorPredicate, ctx)) return fail("INPUT_NOT_ELIGIBLE", "contributor_predicate");

  // the contributor's root key (B10): past_keys[0].pubkey if present, else recipient_pubkey
  const m = s2.master_card_doc as unknown as Record<string, unknown>;
  const past = Array.isArray(m["past_keys"]) ? (m["past_keys"] as { pubkey?: string }[]) : [];
  const rootKey = past[0]?.pubkey ?? (m["recipient_pubkey"] as string);
  return { ok: true, root_key_hash: b64uEncode(sha256(b64uDecode(rootKey))), chain_addresses: s3.chain_card_addresses };
}
