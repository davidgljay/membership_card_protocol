/**
 * Algorithm G: genesis attestation (notary_lifecycle.md Appendix A.3).
 *
 * Checks that a notary card's `recipient_pubkey` (K_id), `chain_pubkey` and `genesis_attestation` were bound
 * together by one enclave for one genesis request. Used by the policy holder before issuing the notary card
 * (`t_eval` = now, `max_age` 7 days) and by later verifiers (`t_eval` = the card's `issued_at`, no `max_age`).
 */
import { sha256 } from "@noble/hashes/sha256";
import { b64uDecode, cardPointer, encodeUserData, hBytes, NotaryFormatError } from "./canonical.js";
import { verifyAttestation } from "./attest.js";
import type { AttestConfig } from "./attest.js";
import type { AcceptedRuntime, AttestationVerifier, GenesisRequest } from "./types.js";

export interface GenesisOffer {
  recipient_pubkey: string;
  chain_pubkey: string;
  /** CID of the purpose-0x01 attestation document. */
  genesis_attestation: string;
  operator_card: string;
}

export interface GenesisChecks {
  /** The attestation document for `offer.genesis_attestation` (already digest-checked against its CID by the caller). */
  attestationDoc: Uint8Array;
  /** The operator card resolves and is not revoked. */
  operatorCardValid(pointer: string): Promise<boolean>;
}

export type GenesisResult = { ok: true; warnings: string[] } | { ok: false; code: string };

export const GENESIS_MAX_AGE_HOLDER_MS = 7 * 24 * 3600 * 1000;

export async function verifyGenesis(o: {
  request: GenesisRequest; offer: GenesisOffer; checks: GenesisChecks; cfg: AttestConfig; modules: AttestationVerifier[];
  acceptedRuntimes: AcceptedRuntime[]; tEvalMs: number; nowMs: number; maxAgeMs?: number;
}): Promise<GenesisResult> {
  const { request: r, offer } = o;
  let userData: Uint8Array, hashed: Uint8Array;
  try {
    userData = encodeUserData({
      purpose: 0x01, idKeyHash: Uint8Array.from(cardPointer(b64uDecode(r.id_pubkey, 1312)).match(/../g)!.map((x) => parseInt(x, 16))),
      chainKeyHash: sha256(b64uDecode(r.chain_pubkey, 64)),
    });
    hashed = hBytes(r);
  } catch (e) { if (e instanceof NotaryFormatError) return { ok: false, code: "NOT_GENESIS_MISMATCH" }; throw e; }
  // 1: V with purpose 0x01, nonce = H(genesis request); inst_key_hash is bound but unknown to the verifier; no public_key
  const v = verifyAttestation(o.checks.attestationDoc, o.cfg, o.modules, { userData, anyInstanceKey: true, nonce: hashed },
    { tEvalMs: o.tEvalMs, nowMs: o.nowMs, ...(o.maxAgeMs !== undefined ? { maxAgeMs: o.maxAgeMs } : {}), acceptedRuntimes: o.acceptedRuntimes, platform: r.platform });
  if (!v.ok) return { ok: false, code: v.code };
  // 2: the offer matches the request and the document
  if (offer.recipient_pubkey !== r.id_pubkey || offer.chain_pubkey !== r.chain_pubkey || offer.operator_card !== r.operator_card)
    return { ok: false, code: "NOT_GENESIS_MISMATCH" };
  // 3: the operator card resolves and is not revoked
  if (!(await o.checks.operatorCardValid(offer.operator_card))) return { ok: false, code: "NOT_OPERATOR_INVALID" };
  return { ok: true, warnings: v.warnings };
}
