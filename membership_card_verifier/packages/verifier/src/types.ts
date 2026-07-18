// ─── Provider Interfaces ────────────────────────────────────────────────────

export interface RpcProvider {
  getCardEntry(address: string): Promise<CardEntry | null>;
  isPolicyAuthorizer(address: string): Promise<boolean>;
  getPressAuthorization(
    policyAddress: string,
    pressAddress: string
  ): Promise<PressAuthEntry | null>;
  getSubCardEntry(subCardAddress: string): Promise<SubCardEntry | null>;
  /**
   * Replays the on-chain event log for a card address and returns the ground-truth,
   * oldest-first sequence of every IPFS object CID this card has ever pointed to,
   * each paired with the authoritative on-chain timestamp it became the head.
   *
   * The registry contract has no on-chain-enumerable per-entry log — `CardEntries`
   * stores only the current `log_head_cid` (`registry_contract.md §3.1`). This
   * method reconstructs the ground-truth CID sequence by filtering that card
   * address's `CardRegistered` (genesis, `initial_log_cid`) and `CardHeadUpdated`
   * (each subsequent entry, `new_log_cid`) events and ordering by block
   * (`registry_contract.md §7`). It returns CIDs and timestamps only — never
   * decrypted card content, which lives on IPFS and is fetched via `IpfsProvider`.
   */
  getCardEventLog(cardAddress: string): Promise<CardChainEvent[]>;
  getEasAnnotations(
    cardAddress: string,
    annotatorAddresses: string[]
  ): Promise<EasAttestation[]>;
}

export interface IpfsProvider {
  fetch(cid: string): Promise<Uint8Array>;
}

// ─── On-Chain Registry Types ─────────────────────────────────────────────────

export interface CardEntry {
  log_head_cid: string;
  policy_address: string;
  last_press_address: string;
  forward_to: string | null;
  exists: boolean;
}

export interface PressAuthEntry {
  press_public_key: string;
  mldsa44_key_hash: string;
  active: boolean;
  authorized_at: string;
  revoked_at: string | null;
}

export interface SubCardEntry {
  master_card_address: string;
  registration_log_head: string;
  sub_card_doc_cid: string;
  active: boolean;
  registered_at: string;
  deregistered_at: string | null;
}

/**
 * One entry in the on-chain event-replay sequence for a card (see
 * `RpcProvider.getCardEventLog`). `cid` is the IPFS object that became the head
 * as of `timestamp` — the genesis `CardDocument` CID for the first entry, or a
 * post-genesis `LogEntry` CID for every subsequent entry. Does not carry
 * `update_code`/`entry_type` — those live only in the IPFS content itself, not
 * on chain; see `stages/stage4.ts` for how content and event-replay are combined.
 */
export interface CardChainEvent {
  cid: string;
  timestamp: string; // ISO 8601 — on-chain block timestamp
}

export interface EasAttestation {
  uid: string;
  attester: string;
  cid: string;
  update_code: number;
  effective_date: string;
}

// ─── IPFS Document Types ──────────────────────────────────────────────────────

export interface CardDocument {
  policy_id: string;
  issuer_card: string;
  press_card: string;
  press_signature: string;
  protocol_version: string;
  recipient_pubkey: string;
  issued_at: string;
  ancestry_pubkeys: string[];
  active_subcards?: string[];
  past_keys?: PastKey[];
  issuer_signature: string;
  holder_signature: string;
  [key: string]: unknown;
}

export interface PastKey {
  pubkey: string;
  valid_from: string;
  rotated_at: string;
}

export interface SubCardDocument {
  holder_primary_card: string;
  holder_primary_card_pubkey: string;
  app_card: string;
  app_card_pubkey: string;
  capabilities: string[];
  limitations?: SubCardLimitation[];
  recipient_pubkey: string;
  issued_at: string;
  valid_until?: string;
  attestation_level: "T1" | "T2";
  attestation_proof?: string;
  app_signature: string;
  holder_signature: string;
}

export interface SubCardLimitation {
  applies_to?: string[];
  field_requirements?: FieldRequirement[];
}

export interface FieldRequirement {
  field: string;
  regex: string;
}

// ─── Configuration ────────────────────────────────────────────────────────────

export interface VerifierConfig {
  rpc: RpcProvider;
  ipfs: IpfsProvider;
  /**
   * The on-chain address (bytes32 hex) of the governance authority's
   * app-certification policy root. Used by Stage 2 to independently re-walk
   * a sub-card's app_card ancestry_pubkeys chain at runtime. Optional —
   * required only for verifier instances that expect to verify signatures
   * from sub-cards. If a sub-card signature is encountered on a verifier
   * instance where this is not configured, Stage 2 hard-rejects with
   * APP_CERTIFICATION_ROOT_NOT_CONFIGURED rather than skipping the check.
   */
  appCertificationRoot?: string | undefined;
  trustedRoots?: string[];
  revocationFreshnessWindowSeconds?: number;
  rejectStaleRevocation?: boolean;
  maxChainDepth?: number;
  registryEndpoint?: string;
  fetchAnnotations?: boolean;
  additionalAnnotators?: string[];
  returnChain?: boolean;
  conditions?: PolicyMatchConditions;
}

// ─── Chain Data & Policy Matching ─────────────────────────────────────────────

export interface ChainLink {
  card_address: string; // keccak256(pubkey) — same as chain_card_addresses today
  public_key: string; // base64url — the raw ML-DSA-44 public key ("public id")
  card_content: Record<string, unknown>; // the decrypted CardDocument's fields
}

export interface PolicyMatchConditions {
  policy_id: string; // CID — checked via issued_under_template semantics
  field_match?: Record<string, string | { regex: string }>; // plain string = exact-match shorthand; { regex } = full regex
}

export interface PolicyMatchResult {
  matched: boolean;
  reason?: "no_policy_match" | "field_mismatch"; // present only when matched === false
}

// ─── API Input Types ──────────────────────────────────────────────────────────

export interface SignedMessageEnvelope {
  payload: {
    message: string;
    protocol_version: string;
    timestamp: string;
    [key: string]: unknown;
  };
  signatures: SignatureEntry[];
}

export interface SignatureEntry {
  key_scheme?: "mldsa44" | "secp256r1_phase1";
  public_key: string;
  signature: string;
}

export interface VerifyCardOptions {
  asOf?: string;
  pubkey?: string; // base64url-encoded public key for cardAddress, if the caller has it —
  // enables real chain population the same way verifyEnvelope's signature-carried
  // pubkey does. Omit to keep today's chain: [] behavior.
}

// ─── Result Types ─────────────────────────────────────────────────────────────

export interface EnvelopeVerificationResult {
  envelope_id: string;
  verified_at: string;
  protocol_version: string;
  signatures: SignatureVerificationResult[];
  policy_match: PolicyMatchResult | null;
}

export interface SignatureVerificationResult {
  signer_card: string;
  signature_valid: boolean | null;
  scope_clean: boolean | "skipped";
  chain_reaches_trusted_root: boolean | "skipped";
  chain_card_addresses: string[]; // on-chain addresses resolved during the Stage 3 chain
  // walk, ordered from the card itself up to the trusted root. Exposed 2026-07-16
  // (Phase 3, Tier 1 item 6) — previously computed internally but not surfaced here.
  app_card_chain_valid: boolean | "skipped";
  revocation: RevocationStatus;
  was_valid_at_signing_time: boolean | "skipped";
  is_currently_valid: boolean | "skipped";
  log_updates: LogUpdate[];
  policy_compliant: boolean | null | "skipped";
  policy_match: PolicyMatchResult | null;
  press_subsequently_revoked: boolean;
  non_compliance_reported: boolean;
  addressed_to_verifier: boolean;
  errors: VerificationError[];
  annotations: EasAnnotation[];
  chain?: ChainLink[];
}

export interface CardVerificationResult
  extends Omit<SignatureVerificationResult, "signature_valid"> {
  signature_valid: null;
  protocol_version: string;
}

export interface RevocationStatus {
  status: "not_revoked" | "revoked" | "loud_revocation" | "unknown";
  code: number | null;
  effective_date: string | null;
  data_freshness_seconds: number;
}

export interface LogUpdate {
  card_address: string;
  update_code: number;
  cid: string;
  effective_date: string;
}

export interface VerificationError {
  stage: 1 | 2 | 3 | 4 | 5 | 6;
  code: string;
  message: string;
}

export interface EasAnnotation {
  eas_uid: string;
  annotator_card: string;
  annotator_chain_trusted: boolean;
  is_recommended_annotator: boolean;
  update_code: number;
  cid: string;
  content: Record<string, unknown>;
  effective_date: string;
}

// ─── Non-Compliance Reporting ─────────────────────────────────────────────────

export interface NonComplianceReport {
  card_address: string;
  press_address: string;
  ipfs_card_document: string;
  ipfs_cid: string;
  failed_checks: FailedCheck[];
  verified_at: string;
}

export interface FailedCheck {
  check: "FIELD_POLICY_VIOLATION" | "NO_PRESS_AUTHORIZATION";
  field?: string;
  detail: string;
}
