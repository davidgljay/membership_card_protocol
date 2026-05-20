/**
 * Signed message envelope produced by a chitt holder (§6 of the Chitt Protocol spec).
 * This is the primary input to validateChitt().
 */
export interface SignedMessageEnvelope {
  payload: MessagePayload;
  signatures: SignatureEntry[];
}

/**
 * The message payload — the content that is canonically serialized and signed.
 * All base64url fields use RFC 4648 §5 encoding (no padding).
 */
export interface MessagePayload {
  content: string;
  /** Mutable pointer addresses (base64url) of the intended recipients. */
  recipients: string[];
  /** ISO 8601 timestamp. */
  timestamp: string;
  /** Hash (base64url) of the prior payload this is replying to. */
  in_reply_to?: string | null;
  /** Hash (base64url) of the prior payload this is an edit of. Mutually exclusive with retracts. */
  edit_of?: string | null;
  /** Hash (base64url) of the prior payload this retracts. Mutually exclusive with edit_of. */
  retracts?: string | null;
}

/**
 * One signer's entry in the signatures array of a message envelope.
 */
export interface SignatureEntry {
  /** On-chain registry address of the signing sub-chitt (base64url). */
  signer_chitt: string;
  /** ML-DSA-44 public key (base64url, 1312 bytes). */
  public_key: string;
  /** ML-DSA-44 signature over the canonical CBOR serialization of the payload (base64url, 2420 bytes). */
  signature: string;
}

/**
 * A chitt document as stored on IPFS (protocol-required fields only;
 * policy-defined fields vary per policy).
 */
export interface ChittDocument {
  /** CID of the policy chitt at time of issuance (base64url). */
  policy_id: string;
  /** Mutable pointer of the press sub-chitt that issued this chitt (base64url). */
  press_chitt: string;
  /** Recipient's ML-DSA-44 public key (base64url, 1312 bytes). */
  recipient_pubkey: string;
  /** ISO 8601 timestamp of issuance. */
  issued_at: string;
  /** Press's ML-DSA-44 signature over the canonical offer payload (base64url). */
  offer_signature: string;
  /** Recipient's ML-DSA-44 countersignature over the completed chitt (base64url). */
  holder_signature: string;
  /** Additional policy-defined fields. */
  [key: string]: unknown;
}

/**
 * A log entry in a chitt's append-only IPFS log.
 */
export interface LogEntry {
  /** Monotonically increasing integer; prevents replay. */
  version: number;
  entry_type: 'field_update' | 'revocation';
  /** CID of the prior log root (base64url). */
  prev_log_root: string;
  field_updates?: Array<{ field: string; value: unknown }>;
  revocation?: RevocationEntry;
  signatures: SignatureEntry[];
}

export interface RevocationEntry {
  /** 7xx friendly, 8xx key compromise, 9xx malicious. */
  code: number;
  /** ISO 8601 timestamp; may predate the recording date. */
  effective_date: string;
  note?: string;
}

/**
 * Registration of a sub-chitt: maps sub-chitt address to its master chitt address.
 */
export interface SubChittRegistration {
  /** On-chain address of the master chitt. */
  masterChittAddress: string;
  /** CID of the master chitt's log head at registration time (base64url). */
  registrationLogHeadCid: string;
}

/**
 * Result of a single signature's validation (per §7 structured result).
 */
export interface SignatureResult {
  signer_chitt: string;
  signature_valid: boolean;
  chain_reaches_trusted_root: boolean;
  scope_clean: boolean;
  revocation: {
    status: 'none' | 'revoked';
    code: number | null;
    effective_date: string | null;
    data_freshness_seconds: number;
  };
  was_valid_at_signing_time: boolean;
  is_currently_valid: boolean;
  addressed_to_verifier: boolean;
  annotations: unknown[];
  error?: string;
}

/**
 * The result returned by validateChitt().
 */
export interface ValidationResult {
  /**
   * True if every signature is cryptographically valid, every chain reaches a
   * trusted root, and no signature was made by a chitt that was under a
   * malicious (9xx) or compromised (8xx) revocation at signing time.
   */
  valid: boolean;
  /**
   * ipfs:// URL of the press sub-chitt that issued the holder's chitt
   * (the entity that authorized this specific chitt issuance).
   * Resolved from the holder's master chitt's press_chitt pointer → log head CID.
   */
  authorizer: string | null;
  /**
   * ipfs:// URL of the policy chitt that governed the issuance.
   * This is the policy_id CID from the holder's master chitt.
   */
  policy: string | null;
  /**
   * ipfs:// URL of the authorizer's chitt — the chitt held by the entity
   * that created/issued the policy chitt itself.
   * Resolved from the policy chitt's press_chitt pointer → log head CID.
   */
  policyCreator: string | null;
  /** Per-signature validation details (§7 structured result). */
  signatures: SignatureResult[];
}

/**
 * Pluggable provider for IPFS and Arbitrum One access.
 * Implement this to connect to real infrastructure or provide test doubles.
 */
export interface ChittProvider {
  /**
   * Fetch and parse a JSON document from IPFS by its CID.
   * CID is a base64url string (no padding) as it appears in chitt fields.
   */
  fetchIPFS(cid: string): Promise<unknown>;

  /**
   * Look up the current log head CID for a registry address on Arbitrum One.
   * Returns null if the address has no registry entry.
   */
  getLogHead(registryAddress: string): Promise<string | null>;

  /**
   * Look up a sub-chitt's registration (which master chitt it belongs to)
   * from the Arbitrum One registry contract.
   */
  getSubChittRegistration(subChittAddress: string): Promise<SubChittRegistration | null>;

  /**
   * Fetch all revocation log entries for a registry address from IPFS
   * (following the prev_log_root chain from the current log head).
   * Returns entries sorted with most recent first.
   */
  getRevocationEntries(
    registryAddress: string,
    logHeadCid: string,
  ): Promise<{ entries: LogEntry[]; fetchedAt: Date }>;
}

/**
 * Options for validateChitt().
 */
export interface ValidationOptions {
  /**
   * Provider for IPFS and Arbitrum One access.
   * Defaults to an HTTP provider using ipfsGateway and arbitrumRpcUrl.
   */
  provider?: ChittProvider;

  /**
   * Registry addresses of chitts the caller unconditionally trusts as chain roots.
   * If a chain walk reaches one of these addresses, chain_reaches_trusted_root is true.
   */
  trustedRoots?: string[];

  /**
   * The verifier's own chitt mutable pointer (base64url).
   * Used to compute addressed_to_verifier. If absent, addressed_to_verifier is false.
   */
  verifierChitt?: string;

  /**
   * Maximum age in seconds of revocation data before it is considered stale.
   * Stale data causes is_currently_valid to be conservatively treated as false.
   * Defaults to 300 (5 minutes).
   */
  freshnessWindowSeconds?: number;

  /** Base URL of the IPFS HTTP gateway. Defaults to 'https://ipfs.io'. */
  ipfsGateway?: string;

  /** Arbitrum One JSON-RPC URL. Defaults to the public Arbitrum One endpoint. */
  arbitrumRpcUrl?: string;

  /** Address of the deployed Chitt registry contract on Arbitrum One. */
  registryContractAddress?: string;
}
