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
  /** Mutable pointer in registry of the signing sub-chitt (base64url). */
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
  /** Mutable pointer in registry of the press sub-chitt that issued this chitt (base64url). */
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
 *
 * Every entry carries a top-level `code` field (100–999) signalling the
 * semantic nature of the update.  `entry_type` is a convenience discriminator
 * derived from the code range (1xx–7xx → field_update; 8xx–9xx → revocation).
 *
 * `intent_signature` covers the canonical CBOR of the UpdateIntentPayload
 * submitted by the updater.  `press_signature` covers the canonical CBOR of
 * the complete LogEntry document excluding the `press_signature` field itself.
 */
export interface LogEntry {
  /** Monotonically increasing integer; prevents replay. */
  version: number;
  /**
   * Three-digit update/revocation code (100–999).
   * Present in ALL entries — not only revocations.
   * Determines trust semantics; see the code system in the spec Background Concepts.
   */
  code: number;
  /** Convenience discriminator derived from code range. */
  entry_type: 'field_update' | 'revocation';
  /** CID of the prior log root (base64url). */
  prev_log_root: string;
  /** Present for codes 1xx–7xx; absent for 8xx–9xx. */
  field_updates?: Array<{ field: string; value: unknown }>;
  /** Present for codes 8xx–9xx; absent for 1xx–7xx. */
  revocation?: RevocationEntry;
  /** Default true; false suppresses the holder Nym notification. */
  notify_holder?: boolean;
  /** Optional message forwarded to the holder in the Nym notification. */
  updater_message?: string;
  /** Updater's signature over the canonical CBOR of the UpdateIntentPayload. */
  intent_signature: SignatureEntry;
  /**
   * Press's signature over the canonical CBOR of the complete LogEntry
   * excluding the `press_signature` field itself.
   */
  press_signature: SignatureEntry;
}

export interface RevocationEntry {
  /**
   * ISO 8601 timestamp of when the revocation condition began.
   * May predate the date the entry was posted to IPFS.
   */
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
 * One entry in the update history of a chitt in the policy creation chain.
 */
export interface ChainUpdate {
  /** Monotonically increasing log version number. */
  version: number;
  entryType: 'field_update' | 'revocation';
  /**
   * Revocation code (7xx friendly, 8xx key compromise, 9xx malicious).
   * null for field_update entries.
   */
  statusCode: number | null;
  /** ipfs:// URL of this specific log entry's CID. */
  cid: string;
}

/**
 * One chitt in a policy creation chain, with its full update history.
 */
export interface PolicyChainLink {
  /** Arbitrum One registry address of this chitt. */
  chittAddress: string;
  /** ipfs:// URL of the current log head CID (the chitt's present state). */
  logHeadUrl: string | null;
  /**
   * All update log entries for this chitt, newest first.
   * Empty when the chitt has never been updated since issuance.
   */
  updates: ChainUpdate[];
}

/**
 * The three policy creation chains returned with every validation result.
 * Each chain walks upward via press_chitt links, collecting the full update
 * history of each chitt encountered.
 */
export interface ValidationChains {
  /**
   * Policy creation chain starting from the signed chitt's holder (the message
   * sender's master chitt), walking upward through each chitt's press_chitt.
   */
  chitt: PolicyChainLink[];
  /**
   * Policy creation chain starting from the press that signed and issued the
   * chitt to the holder (the "person who signed the creation of the chitt").
   */
  chittAuthorizer: PolicyChainLink[];
  /**
   * Policy creation chain starting from the entity that created the policy chitt
   * itself (the "person who signed the creation of the policy").
   * Resolved from the policy chitt's own press_chitt field.
   */
  policyCreator: PolicyChainLink[];
}

/**
 * A log entry plus the CID at which it was fetched from IPFS.
 */
export interface LogEntryWithCid {
  entry: LogEntry;
  cid: string;
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
  /**
   * Policy creation chains for the chitt holder, the chitt's authorizer (press),
   * and the policy's creator. Each chain contains the full update history of
   * every chitt walked, with CID links and status codes.
   * null if chain resolution failed (e.g. IPFS/Arbitrum unavailable).
   */
  chains: ValidationChains | null;
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
   * Walk the IPFS log from logHeadCid backward through prev_log_root links,
   * returning ALL log entries (field updates and revocations) with their CIDs,
   * plus the genesis ChittDocument at the root of the log.
   *
   * Entries are returned newest-first (head → genesis direction).
   * The genesis document is the original chitt JSON (no entry_type field).
   * It contains press_chitt and policy_id used for upward chain walking.
   */
  getAllLogEntries(
    registryAddress: string,
    logHeadCid: string,
  ): Promise<{ entries: LogEntryWithCid[]; genesis: ChittDocument | null; fetchedAt: Date }>;
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
