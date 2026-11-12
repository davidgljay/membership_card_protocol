/**
 * Algorithm L: governance list approval (notary_lifecycle.md Appendix A.5; protocol-objects.md §34).
 *
 * Run on a list card's verified log before its list is used. The caller supplies the list's version history
 * (oldest first, head last), each with the `list` field value and the `list_approval` text field, and the
 * trusted keyset K = { keys, quorum, version, key_scheme } (wallets and verifiers read it from the on-chain
 * `GovernanceKeysets[PressRegistryBody]`; runtimes use the keyset built into the image).
 *
 * Signed message (errata E6, E12): each member signs the 32 raw bytes of H(JCS(approval without "signatures")).
 * Scheme 0 is ECDSA secp256r1 (64-byte r‖s) with that digest used directly as the message hash (E12, one
 * pluggable function below); scheme 1 is ML-DSA-44 over the 32 digest bytes.
 */
import { p256 } from "@noble/curves/p256";
import { ml_dsa44 } from "@noble/post-quantum/ml-dsa.js";
import { b64uDecode, hBytes, H, parseCanonicalNotary, withoutFields, NotaryFormatError } from "./canonical.js";
import { assertNotaryObject } from "./types.js";
import type { ListApproval } from "./types.js";

/** Protocol constant (protocol-objects.md §34). */
export const EMERGENCY_RETIREMENT_THRESHOLD = 2;

export interface GovernanceKeyset {
  /** scheme 0: 64-byte x‖y; scheme 1: 1312-byte ML-DSA-44 public keys. */
  keys: Uint8Array[];
  quorum: number;
  version: number;
  key_scheme: 0 | 1;
}

export interface ListVersion {
  /** The `list` field's value at this version (RFC 8785-serializable array). */
  value: unknown[];
  /** The `list_approval` text field at this version (RFC 8785 canonical JSON); absent if the card has none. */
  approvalText: string | undefined;
}

export type ListResult =
  | { ok: true; list: unknown[]; listVersion: number }
  | { ok: false; code: ListCode };

export type ListCode =
  | "LIST_APPROVAL_MISSING" | "LIST_APPROVAL_MALFORMED" | "LIST_APPROVAL_HASH_MISMATCH"
  | "LIST_APPROVAL_KEYSET_STALE" | "LIST_APPROVAL_THRESHOLD" | "LIST_APPROVAL_NOT_REMOVAL_ONLY";

/** One member signature over the 32-byte digest. The single place E12 is decided. */
export function verifyMemberSignature(scheme: 0 | 1, publicKey: Uint8Array, digest: Uint8Array, signature: Uint8Array): boolean {
  try {
    if (scheme === 0) {
      if (publicKey.length !== 64 || signature.length !== 64) return false;
      const uncompressed = new Uint8Array(65);
      uncompressed[0] = 0x04;
      uncompressed.set(publicKey, 1);
      return p256.verify(signature, digest, uncompressed, { lowS: false });
    }
    return ml_dsa44.verify(signature, digest, publicKey);
  } catch {
    return false;
  }
}

/** The digest members sign: SHA-256 of the canonical approval without its `signatures`. */
export function approvalDigest(approval: Record<string, unknown>): Uint8Array {
  return hBytes(withoutFields(approval, "signatures"));
}

const keyOf = (e: unknown, f: "pcr0" | "program_cid") => (e as Record<string, unknown>)[f];

/** Rule E (§34): removal-only change. */
export function isRemovalOnly(prev: unknown[], next: unknown[], field: "pcr0" | "program_cid"): boolean {
  if (prev.length !== next.length) return false;
  let changed = 0;
  for (let i = 0; i < prev.length; i++) {
    const a = prev[i] as Record<string, unknown>, b = next[i] as Record<string, unknown>;
    if (keyOf(a, field) !== keyOf(b, field)) return false;
    if (H(withoutFields(a, "retire_reason", "retired_at")) !== H(withoutFields(b, "retire_reason", "retired_at"))) return false;
    if (H(a) === H(b)) continue;
    // changed: must now be vulnerable with retired_at added or moved earlier
    if (b["retire_reason"] !== "vulnerable" || typeof b["retired_at"] !== "string") return false;
    const before = a["retired_at"];
    if (typeof before === "string" && !(Date.parse(b["retired_at"] as string) < Date.parse(before))) return false;
    changed++;
  }
  return changed >= 1;
}

function parseApproval(text: string | undefined, list: "accepted_runtimes" | "program_allowlist", listCard: string):
  { approval: ListApproval } | { code: ListCode } {
  if (text === undefined) return { code: "LIST_APPROVAL_MISSING" };
  try {
    const obj = parseCanonicalNotary(new TextEncoder().encode(text));
    assertNotaryObject(obj, "notary_list_approval");
    const a = obj as unknown as ListApproval;
    if (a.list !== list || a.list_card !== listCard) return { code: "LIST_APPROVAL_MALFORMED" };
    if (!Array.isArray(a.signatures) || !Number.isInteger(a.list_version) || a.list_version < 1 || !["standard", "emergency_retirement"].includes(a.kind))
      return { code: "LIST_APPROVAL_MALFORMED" };
    return { approval: a };
  } catch (e) {
    if (e instanceof NotaryFormatError) return { code: "LIST_APPROVAL_MALFORMED" };
    throw e;
  }
}

/**
 * Algorithm L steps 1–5 on the head of `history` (and, for an emergency head, on earlier versions back to
 * the most recent standard one).
 */
export function verifyListApproval(o: {
  list: "accepted_runtimes" | "program_allowlist";
  listCard: string;
  history: ListVersion[];
  keyset: GovernanceKeyset;
}): ListResult {
  const field = o.list === "accepted_runtimes" ? "pcr0" : "program_cid";
  const { keyset: K, history } = o;
  let headVersion = 0;
  for (let idx = history.length - 1; idx >= 0; idx--) {
    const ver = history[idx]!, prev = idx > 0 ? history[idx - 1] : undefined;
    // 1
    const parsed = parseApproval(ver.approvalText, o.list, o.listCard);
    if ("code" in parsed) return { ok: false, code: parsed.code };
    const a = parsed.approval;
    if (idx === history.length - 1) headVersion = a.list_version;
    // 2
    try {
      if (a.list_hash !== H(ver.value)) return { ok: false, code: "LIST_APPROVAL_HASH_MISMATCH" };
      if (a.list_version > 1) {
        const prevParsed = prev ? parseApproval(prev.approvalText, o.list, o.listCard) : undefined;
        if (!prev || a.prev_list_hash !== H(prev.value) || !prevParsed || "code" in prevParsed || prevParsed.approval.list_version + 1 !== a.list_version)
          return { ok: false, code: "LIST_APPROVAL_HASH_MISMATCH" };
      } else if (a.prev_list_hash !== undefined) return { ok: false, code: "LIST_APPROVAL_HASH_MISMATCH" };
    } catch (e) { if (e instanceof NotaryFormatError) return { ok: false, code: "LIST_APPROVAL_HASH_MISMATCH" }; throw e; }
    // 3
    if (a.governance_version !== K.version) return { ok: false, code: "LIST_APPROVAL_KEYSET_STALE" };
    // 4
    const digest = approvalDigest(a as unknown as Record<string, unknown>);
    const signers = new Set<number>();
    for (const s of a.signatures) {
      if (!Number.isInteger(s.key_index) || s.key_index < 0 || s.key_index >= K.keys.length) continue;
      let sig: Uint8Array;
      try { sig = b64uDecode(s.signature); } catch { continue; }
      if (verifyMemberSignature(K.key_scheme, K.keys[s.key_index]!, digest, sig)) signers.add(s.key_index);
    }
    const need = a.kind === "standard" ? K.quorum : EMERGENCY_RETIREMENT_THRESHOLD;
    if (signers.size < need) return { ok: false, code: "LIST_APPROVAL_THRESHOLD" };
    if (a.kind === "standard") return { ok: true, list: history[history.length - 1]!.value, listVersion: headVersion };
    // 5: emergency: removal-only against the previous version, then verify that version too
    if (!prev || !isRemovalOnly(prev.value, ver.value, field)) return { ok: false, code: "LIST_APPROVAL_NOT_REMOVAL_ONLY" };
  }
  return { ok: false, code: "LIST_APPROVAL_MISSING" }; // ran out of history without reaching a standard version
}


