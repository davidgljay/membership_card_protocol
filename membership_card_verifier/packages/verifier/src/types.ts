// ─── Provider Interfaces ────────────────────────────────────────────────────

export interface RpcProvider {
  getCardEntry(address: string): Promise<CardEntry | null>;
  isPolicyAuthorizer(address: string): Promise<boolean>;
  getPressAuthorization(
    policyAddress: string,
    pressAddress: string
  ): Promise<PressAuthEntry | null>;
  getSubCardEntry(subCardAddress: string): Promise<SubCardEntry | null>;
  getLogEntries(cardAddress: string): Promise<LogEntry[]>;
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

export interface LogEntry {
  update_code: number;
  effective_date: string;
  cid: string;
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
  appCertificationRoot: string;
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
}

// ─── Result Types ─────────────────────────────────────────────────────────────

export interface EnvelopeVerificationResult {
  envelope_id: string;
  verified_at: string;
  protocol_version: string;
  signatures: SignatureVerificationResult[];
  policy_match: boolean | null;
}

export interface SignatureVerificationResult {
  signer_card: string;
  signature_valid: boolean | null;
  scope_clean: boolean | "skipped";
  chain_reaches_trusted_root: boolean | "skipped";
  app_card_chain_valid: boolean | "skipped";
  revocation: RevocationStatus;
  was_valid_at_signing_time: boolean | "skipped";
  is_currently_valid: boolean | "skipped";
  log_updates: LogUpdate[];
  policy_compliant: boolean | null | "skipped";
  policy_match: boolean | null;
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
