/**
 * Shared domain types for the press.
 *
 * HTTP request/response bodies, policy document shape, and
 * intermediate data structures passed between press functions.
 */

// ---------------------------------------------------------------------------
// Policy document (public IPFS document, fetched without decryption)
// ---------------------------------------------------------------------------

export interface PolicyDocument {
  policy_id: string;
  field_definitions: Record<string, FieldDefinition>;
  approved_presses: string[];
  valid_until?: string;
  requester_predicate?: Predicate;
  recipient_predicate?: Predicate;
  update_policy?: Record<string, Predicate>;
  revocation_permissions?: RevocationPermissions;
  auditors?: string[];
  allow_open_offers?: boolean;
  [key: string]: unknown;
}

export interface FieldDefinition {
  type: string;
  required?: boolean;
  [key: string]: unknown;
}

export interface Predicate {
  type: string;
  [key: string]: unknown;
}

export interface RevocationPermissions {
  issuer?: boolean;
  holder?: boolean;
  admin?: boolean;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Issuer offer (signed by the issuer's wallet service before reaching press)
// ---------------------------------------------------------------------------

export interface IssuerOffer {
  policy_id: string;
  issuer_card: string;
  press_card: string;
  issued_at: string;
  /**
   * `protocol-objects.md §1`: immediate parent (the issuer's own public
   * key) toward the trusted root, `[]` only if the issuer card is itself a
   * trusted root or its immediate parent is. `issuer_signature` is verified
   * against `ancestry_pubkeys[0]`, binding-checked against `issuer_card`
   * (`keccak256(ancestry_pubkeys[0]) == issuer_card`) — there is currently
   * no path to verify an offer from a root-level issuer with no ancestry
   * hint at all (same limitation `wallet-sdk`'s client-side
   * `reviewTargetedOffer` already has).
   */
  ancestry_pubkeys?: string[];
  /** base64url ML-DSA-44 signature — `protocol-objects.md §1` documents CardDocument's three signatures as bare strings, not `{ public_key, signature }` objects; the signer's public key is never embedded in its own signature field. */
  issuer_signature: string;
  [key: string]: unknown; // policy field values
}

export interface SignatureField {
  public_key: string; // base64url ML-DSA-44 public key
  signature: string;  // base64url ML-DSA-44 signature
}

// ---------------------------------------------------------------------------
// HTTP request bodies
// ---------------------------------------------------------------------------

export interface IssuanceRequest {
  policy_cid: string;
  requester_card_address: string;
  offer: IssuerOffer;
  /** On-chain address of the recipient card (for targeted issuance to an existing holder). */
  recipient_card_address?: string;
}

export interface IssuanceResponse {
  offer_cid: string;
}

export interface FinalizeRequest {
  offer_cid: string;
  recipient_pubkey: string; // base64url ML-DSA-44 public key
  /** base64url — see `IssuerOffer.issuer_signature`'s comment; verified against `recipient_pubkey`, not an embedded key. */
  holder_signature: string;
  past_keys?: PastKey[];
}

export interface PastKey {
  pubkey: string;
  valid_from: string;
  rotated_at: string;
}

export interface FinalizeResponse {
  card_cid: string;
  scip: ScipObject;
}

// ---------------------------------------------------------------------------
// Open offer types
// ---------------------------------------------------------------------------

export interface OpenCardOffer {
  policy_id: string;
  issuer_card: string;
  press_card: string;
  issued_at: string;
  expires_at?: string;
  max_acceptances?: number;
  offer_id?: string;
  /** `protocol-objects.md §7`: an explicit, separate field — not embedded in `issuer_signature`. `issuer_signature` covers all other fields, including this one; a verifier must confirm `keccak256(issuer_pubkey) == issuer_card` before trusting it. */
  issuer_pubkey: string;
  /** base64url — see `IssuerOffer.issuer_signature`'s comment. */
  issuer_signature: string;
  [key: string]: unknown;
}

export interface OpenOfferClaimSubmission {
  claim_payload: {
    offer: OpenCardOffer;
    recipient_pubkey: string;
  };
  /** base64url — sig over canonical JSON of the entire `claim_payload`, verified against `claim_payload.recipient_pubkey` (`protocol-objects.md §7`). */
  recipient_signature: string;
}

export interface OpenOfferClaimResponse {
  card_cid: string;
  scip: ScipObject;
}

// ---------------------------------------------------------------------------
// Update types
// ---------------------------------------------------------------------------

export interface FieldUpdate {
  field: string;
  value: unknown;
}

export interface UpdateIntentPayload {
  updater_card_address: string;
  target_card_address: string;
  code: number;
  timestamp: string;
  /** `[{ field, value }, ...]` per `process_specs/card_updates.md` — not a keyed record. */
  field_updates?: FieldUpdate[];
  revocation?: {
    code: number;
    effective_date: string;
    note?: string;
  };
  notify_holder?: boolean;
  updater_message?: string;
}

export interface UpdateRequest {
  update_intent: UpdateIntentPayload;
  intent_signature: SignatureField;
}

export interface UpdateResponse {
  log_entry_cid: string;
  new_log_head_cid: string;
}

// ---------------------------------------------------------------------------
// Sub-card types
// ---------------------------------------------------------------------------

export interface SubCardDocument {
  holder_primary_card: string;
  holder_primary_card_pubkey: string;
  app_card: string;
  app_card_pubkey: string;
  capabilities: string[];
  recipient_pubkey: string;
  issued_at: string;
  valid_until?: string;
  attestation_level: 'T1' | 'T2';
  attestation_proof?: string;
  app_signature: SignatureField;
  holder_signature?: SignatureField;
}

export interface SubCardRegistrationRequest {
  sub_card_document: SubCardDocument;
  holder_signature: SignatureField;
  /** Required when the master card is a DNS admin card. */
  admin_secp_payload?: string;
  admin_secp_signature?: string;
}

export interface SubCardRegistrationResponse {
  sub_card_doc_cid: string;
  tx_hash: string;
}

export interface SubCardDeregistrationRequest {
  sub_card_address: string;
  sig_payload: {
    op: 'deregister_sub_card';
    sub_card_address: string;
    timestamp: string;
  };
  /** base64url ML-DSA-44 signature from master card holder */
  master_signature: string;
}

export interface SubCardDeregistrationResponse {
  tx_hash: string;
}

// ---------------------------------------------------------------------------
// SCIP (Signed Card Inclusion Proof)
// ---------------------------------------------------------------------------

export interface ScipObject {
  card_cid: string;
  policy_log_entry_index: number;
  policy_log_root_at_inclusion: string;
  issued_at: string;
  press_signature: SignatureField;
}

// ---------------------------------------------------------------------------
// Press error response
// ---------------------------------------------------------------------------

export interface PressError {
  error: string;   // P-XX code
  message: string;
}

export function pressError(code: string, message: string): PressError {
  return { error: code, message };
}
