/**
 * Notary-issued (derived) cards: Stage 5 step 3a (card_verifier.md §7.5; protocol-objects.md §2.2, §20).
 *
 * In order:
 * 1. **Algorithm G** on the notary card's `genesis_attestation` with `t_eval` = the notary card's `issued_at` and no
 *    `max_age`. A later verifier recomputes the attestation nonce from the **genesis request**, fetched by the
 *    notary card's `genesis_request` CID (erratum E17, accepted 2026-11-12: a new immutable field on the card) and
 *    required to equal the card's own fields. Failure → `NOTARY_GENESIS_INVALID`.
 * 2. **Shape:** `issuer_card == press_card`, and `ancestry_pubkeys` is `[notary card key, template key]`
 *    → `NOTARY_DERIVED_SHAPE`.
 * 3. **Algorithm E** on the notary card at `t` = the derived card's `CardRegistered` timestamp: exposed at or before
 *    `t` → `NOTARY_KEY_EXPOSED`; after `t` → warning `notary_key_exposed_later`; broken identity log →
 *    `NOTARY_LINEAGE_INCOMPLETE`.
 * 4. **Source kind:** the template's `derived_card.source_kind` is absent or `"card"`, else `NOTARY_DERIVED_SHAPE`.
 * `dup_tag` is returned, not checked.
 *
 * All reads are injected (the `CardVerifier`-backed adapter is Phase 7).
 */
import { b64uEncode, parseCanonicalNotary, parseTimestamp, digestFromCid } from "./canonical.js";
import { assertNotaryObject, NOTARY_CODES } from "./types.js";
import { sha256 } from "@noble/hashes/sha256";
import { verifyGenesis } from "./genesis.js";
import type { AttestConfig } from "./attest.js";
import type { AcceptedRuntime, AttestationVerifier, GenesisRequest, NotaryCardFields, NotarySection } from "./types.js";

export interface NotaryIssuedReads {
  fetch(cid: string): Promise<Uint8Array | null>;
  /** The operator card resolves and is not revoked. */
  operatorCardValid(pointer: string): Promise<boolean>;
  /** Algorithm E (A.6) for the notary card at chain time `tMs`. */
  keyExposure(pointer: string, tMs: number): Promise<"none" | "exposed" | "later" | "lineage_incomplete">;
}

export interface NotaryIssuedInput {
  derived: { issuer_card: string; press_card: string; ancestry_pubkeys: string[]; expires_at?: string; source_policy?: string; projected?: string; dup_tag?: string };
  notaryCard: NotaryCardFields & { issued_at: string };
  notaryCardPointer: string;
  /** The template policy's public key (second element of `ancestry_pubkeys`), base64url. */
  templateKey: string;
  /** The notary policy CID the notary card serves (the genesis request's `policy_id`). */
  notaryPolicyId: string;
  templateNotary: Pick<NotarySection, "derived_card">;
  /** Timestamp (ms) of the derived card's `CardRegistered` event. */
  registeredAtMs: number;
  nowMs: number;
  cfg: AttestConfig;
  modules: AttestationVerifier[];
  acceptedRuntimes: AcceptedRuntime[];
  reads: NotaryIssuedReads;
}

export type NotaryIssuedResult =
  | { ok: true; warnings: string[]; derived: { source_policy?: string; projected?: string; dup_tag?: string; expires_at?: string } }
  | { ok: false; code: string; detail: string };

const fail = (code: string, detail: string): NotaryIssuedResult => ({ ok: false, code, detail });

export async function verifyNotaryIssuedCard(o: NotaryIssuedInput): Promise<NotaryIssuedResult> {
  const warnings: string[] = [];
  const card = o.notaryCard;
  // ---- 1: algorithm G, with the request fetched by the card's `genesis_request` CID ----
  const reqBytes = await o.reads.fetch(card.genesis_request);
  let request: GenesisRequest;
  try {
    if (!reqBytes || b64uEncode(digestFromCid(card.genesis_request)) !== b64uEncode(sha256(reqBytes))) return fail(NOTARY_CODES.GENESIS_INVALID, "genesis request not available or does not match its CID");
    const obj = parseCanonicalNotary(reqBytes);
    assertNotaryObject(obj, "notary.genesis_request.v1");
    request = obj as unknown as GenesisRequest;
  } catch (e) { return fail(NOTARY_CODES.GENESIS_INVALID, `genesis request malformed: ${(e as Error).message}`); }
  if (request.id_pubkey !== card.recipient_pubkey || request.chain_pubkey !== card.chain_pubkey || request.operator_card !== card.operator_card ||
      request.operator_host_pubkey !== card.operator_host_pubkey || request.platform !== card.platform || request.policy_id !== o.notaryPolicyId)
    return fail(NOTARY_CODES.GENESIS_INVALID, "the genesis request does not match the notary card's fields");
  const attDoc = await o.reads.fetch(card.genesis_attestation);
  try { if (!attDoc || b64uEncode(digestFromCid(card.genesis_attestation)) !== b64uEncode(sha256(attDoc))) return fail(NOTARY_CODES.GENESIS_INVALID, "genesis attestation not available or does not match its CID"); }
  catch { return fail(NOTARY_CODES.GENESIS_INVALID, "genesis_attestation is not a raw CID"); }
  const g = await verifyGenesis({
    request, offer: { recipient_pubkey: card.recipient_pubkey, chain_pubkey: card.chain_pubkey, genesis_attestation: card.genesis_attestation, operator_card: card.operator_card },
    checks: { attestationDoc: attDoc, operatorCardValid: o.reads.operatorCardValid }, cfg: o.cfg, modules: o.modules, acceptedRuntimes: o.acceptedRuntimes,
    tEvalMs: parseTimestamp(card.issued_at), nowMs: o.nowMs,
  });
  if (!g.ok) return fail(NOTARY_CODES.GENESIS_INVALID, `algorithm G: ${g.code}`);
  warnings.push(...g.warnings);
  // ---- 2: shape ----
  const d = o.derived;
  if (d.issuer_card !== d.press_card || d.press_card !== o.notaryCardPointer) return fail(NOTARY_CODES.DERIVED_SHAPE, "issuer_card and press_card must both be the notary card");
  if (d.ancestry_pubkeys.length !== 2 || d.ancestry_pubkeys[0] !== card.recipient_pubkey || d.ancestry_pubkeys[1] !== o.templateKey)
    return fail(NOTARY_CODES.DERIVED_SHAPE, "ancestry_pubkeys must be [notary card key, template key]");
  // ---- 3: algorithm E ----
  const x = await o.reads.keyExposure(o.notaryCardPointer, o.registeredAtMs);
  if (x === "exposed") return fail(NOTARY_CODES.KEY_EXPOSED, "the notary key lived in a runtime retired as vulnerable before this card was registered");
  if (x === "lineage_incomplete") return fail(NOTARY_CODES.LINEAGE_INCOMPLETE, "the notary card's identity log has a gap or fork");
  if (x === "later") warnings.push("notary_key_exposed_later");
  // ---- 4: source kind ----
  const kind = o.templateNotary.derived_card?.source_kind;
  if (kind !== undefined && kind !== "card") return fail(NOTARY_CODES.DERIVED_SHAPE, `source_kind ${JSON.stringify(kind)} is not supported by this version`);
  const { source_policy, projected, dup_tag, expires_at } = d;
  return { ok: true, warnings: [...new Set(warnings)], derived: { ...(source_policy !== undefined ? { source_policy } : {}), ...(projected !== undefined ? { projected } : {}), ...(dup_tag !== undefined ? { dup_tag } : {}), ...(expires_at !== undefined ? { expires_at } : {}) } };
}


