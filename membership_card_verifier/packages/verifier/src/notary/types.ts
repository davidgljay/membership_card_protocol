/**
 * Notary object types a verifier meets.
 *
 * Implements: protocol-objects.md §2.1, §2.2, §20, §27, §28, §33, §34 and the shared
 *   AttestationVerifier interface (notary_runtime.md §5).
 * Wallet objects (§21–§26) live in wallet-sdk/src/notary/types.ts; host/enclave-only objects
 * (§29–§32) in notary/host. All three are checked against notary/vectors/ (code-plan §3.1).
 *
 * `OBJECT_FIELDS` is the strict field table for every versioned notary object (Q6: unknown
 * top-level fields are rejected; a new field means a new `type` version).
 */
import { assertExactFields, NotaryFormatError } from "./canonical.js";

export type Base64Url = string;
export type Cid = string;
export type CardPointer = string;
export type Timestamp = string;

export interface SignatureEntry { public_key: Base64Url; signature: Base64Url }

// ---- §2.1 / §2.2 policy sections -----------------------------------------------------------

/** A field definition in the card field type system; kept open because it is policy-defined. */
export type FieldDefinition = Record<string, unknown>;
/** A card predicate; leaves may be `{ param: name }` inside a notary section only (§2.1). */
export type CardPredicate = Record<string, unknown>;

export interface NotaryLimits { fuel?: number; max_inputs?: number; memory_pages?: number; wall_ms?: number }

export interface DerivedCardParams {
  source_kind?: "card" | string;
  nullifier_period?: string;
  renewal_window?: string;
  issuance_batch_interval?: string;
  min_batch_size?: number;
  min_anonymity_set?: number;
}

export interface RevocationPropagation {
  mode: "expiry_only" | "sealed_link" | "escrowed_link";
  propagated_codes?: (number | string)[];
  derived_code?: string | number;
  min_delay?: string;
  batch_window?: string;
  min_revocation_batch?: number;
}

export interface NotarySection {
  contributor_predicate: CardPredicate;
  derived_card?: DerivedCardParams;
  input_replacement: "reject_duplicates" | "latest_wins";
  input_schema: FieldDefinition[];
  isolation: "shared" | "dedicated";
  job_requester_predicate?: CardPredicate;
  limits?: NotaryLimits;
  mode: "aggregate" | "per_input";
  output_action: "statement" | "card";
  output_recipients?: { cards: CardPointer[]; job_requester: boolean; public: boolean };
  output_schema: FieldDefinition[];
  parameter_bounds?: FieldDefinition[];
  platform: "aws-nitro-enclaves" | "simulator";
  privacy: { k_min: number; dp?: unknown };
  program_cid: Cid;
  retention: "none";
  revocation_propagation?: RevocationPropagation;
}

/** `T` template policy fields (§2.2). `projected` is RFC 8785 JSON inside a text field. */
export interface DerivedCardFields { source_policy: Cid; projected: string; dup_tag: Base64Url }

// ---- §20 notary card + genesis request -----------------------------------------------------

export interface NotaryCardFields {
  chain_pubkey: Base64Url;
  genesis_attestation: Cid;
  /** CID of the pinned genesis request (erratum E17, accepted): lets a later verifier recompute the attestation nonce. */
  genesis_request: Cid;
  issuer_card: CardPointer;
  operator_card: CardPointer;
  operator_host_pubkey: Base64Url;
  platform: "aws-nitro-enclaves" | "simulator";
  policy_id: Cid;
  recipient_pubkey: Base64Url;
}

export interface GenesisRequest {
  chain_pubkey: Base64Url; id_pubkey: Base64Url; nonce: Base64Url; operator_card: CardPointer;
  operator_host_pubkey: Base64Url; platform: string; policy_id: Cid; requested_at: Timestamp;
  type: "notary.genesis_request.v1";
}

// ---- §27 notarization, §28 job log ---------------------------------------------------------

export interface ChainState { block_hash: Base64Url; block_number: number; block_timestamp: Timestamp; state_root: Base64Url }
export interface Cosignature { attestation: Cid; instance_signature: SignatureEntry }

export interface Notarization {
  accepted: number; attestation: Cid; chain_state: ChainState; close_quorum: number; closed_at: Timestamp;
  cosignatures: Cosignature[]; counted_inputs: Cid; dropped_after_acceptance: number; final_epoch: number;
  input_commitment: Base64Url; job_cid: Cid; job_hash: Base64Url; job_log_head: Cid; notary_card: CardPointer;
  notary_signature: SignatureEntry; output: { public: unknown } | { recipients: CardPointer[] };
  output_hash: Base64Url; platform: string; policy_id: Cid; policy_state_cid: Cid; program_cid: Cid;
  rejected: number; suppressed: boolean; type: "notary.notarization.v1";
}

export type JobLogKind = "opened" | "epoch_started" | "handoff" | "replica_lost" | "replicated" | "closed" | "notarized" | "issued" | "aborted";

export interface JobLogRecord {
  at: Timestamp; body: Record<string, unknown>; instance: Base64Url; instance_signature: SignatureEntry;
  job_hash: Base64Url; kind: JobLogKind; notary_signature: SignatureEntry; prev?: Cid; seq: number;
  type: "notary.job_log.v1" | "notary.identity_log.v1";
}

// ---- §33 attestation binding, §34 governance lists -----------------------------------------

export interface AcceptedRuntime {
  accepted_from: Timestamp; build_recipe_cid: Cid; close_compat: string; pcr0: Base64Url; platform: string;
  retire_reason?: "superseded" | "vulnerable"; retired_at?: Timestamp; source_commit: string; version: string;
}
export interface AllowlistedProgram {
  accepted_from: Timestamp; audit_report_cid: Cid; name: string; program_cid: Cid;
  retire_reason?: "superseded" | "vulnerable"; retired_at?: Timestamp; source_commit: string; toolchain: string; version: string;
}
export interface ListApproval {
  type: "notary_list_approval"; list: "accepted_runtimes" | "program_allowlist"; list_card: CardPointer;
  list_version: number; list_hash: Base64Url; prev_list_hash?: Base64Url; kind: "standard" | "emergency_retirement";
  governance_version: number; signatures: { key_index: number; signature: Base64Url }[];
  /** Program allowlist only; absent means "allowed" (protocol-objects.md §34, 2026-11-12). */
  single_operator_quorums?: "allowed" | "refused";
}

// ---- AttestationVerifier (notary_runtime.md §5) --------------------------------------------

export type EnvelopeFailureCode = "ATT_MALFORMED" | "ATT_ROOT_MISMATCH" | "ATT_CHAIN_INVALID" | "ATT_SIGNATURE_INVALID";

export interface AttestationVerifier {
  platform: "aws-nitro-enclaves" | "simulator";
  verifyEnvelope(doc: Uint8Array, trustRoot: Uint8Array):
    | { ok: true; measurement: Uint8Array; pcrs: Map<number, Uint8Array>; timestamp: number;
        userData: Uint8Array; nonce?: Uint8Array; publicKey?: Uint8Array }
    | { ok: false; code: EnvelopeFailureCode };
}

// ---- Strict field table --------------------------------------------------------------------

export interface FieldSpec { required: string[]; optional?: string[] }

export const OBJECT_FIELDS: Record<string, FieldSpec> = {
  "notary.genesis_request.v1": { required: ["chain_pubkey", "id_pubkey", "nonce", "operator_card", "operator_host_pubkey", "platform", "policy_id", "requested_at", "type"] },
  "notary.job.v1": {
    required: ["created_at", "kem", "min_live", "nonce", "opens_at", "parameters", "policy_id", "policy_state_cid", "replica_set", "requester_card", "requester_pubkey", "requester_signature", "type"],
    optional: ["closes_at", "ends_at", "key_period", "requester_text"],
  },
  "notary.announcement.v1": {
    required: ["attestations", "epoch", "issued_at", "job", "job_public_key", "notary_signature", "transport", "type"],
    optional: ["epoch_reason", "prev_announcement"],
  },
  "notary.input.v1": { required: ["chain_ref", "contributor_card", "contributor_card_pubkey", "contributor_signature", "evidence", "job_hash", "payload", "revision", "signed_at", "type"] },
  "notary.countersign.v1": { required: ["holder_signature", "job_hash", "offer_hash", "type"] },
  "notary.sealed_input.v1": { required: ["ct", "enc", "epoch", "job_hash", "kem", "type"] },
  "notary.host_receipt.v1": { required: ["epoch", "host_signature", "input_hash", "job_hash", "notary_card", "received_at", "type"] },
  "notary.validation_receipt.v1": {
    required: ["acks", "epoch", "input_hash", "instance", "job_hash", "notary_signature", "processed_at", "revision", "status", "type"],
    optional: ["derived_offer", "reject_reason"],
  },
  "notary.notarization.v1": {
    required: ["accepted", "attestation", "chain_state", "close_quorum", "closed_at", "cosignatures", "counted_inputs", "dropped_after_acceptance", "final_epoch", "input_commitment", "job_cid", "job_hash", "job_log_head", "notary_card", "notary_signature", "output", "output_hash", "platform", "policy_id", "policy_state_cid", "program_cid", "rejected", "suppressed", "type"],
  },
  "notary.job_log.v1": { required: ["at", "body", "instance", "instance_signature", "job_hash", "kind", "notary_signature", "seq", "type"], optional: ["prev"] },
  "notary.identity_log.v1": { required: ["at", "body", "instance", "instance_signature", "job_hash", "kind", "notary_signature", "seq", "type"], optional: ["prev"] },
  "notary.handoff.v1": {
    required: ["at", "from_attestation", "from_instance", "pcr0_from", "pcr0_to", "receiver_signature", "scope", "state_hash", "state_version", "to_attestation", "to_instance", "to_notary_card", "type"],
    optional: ["epoch", "job_hash", "key_generation"],
  },
  "notary.heartbeat.v1": { required: ["chain_head", "instance", "instance_signature", "jobs", "list_versions", "peers_seen", "seq", "type"], optional: ["identity_state_version"] },
  "notary.state_blob.v1": { required: ["at", "body_cid", "body_hash", "notary_card", "notary_signature", "type", "version"], optional: ["prev_hash"] },
  "notary.propagation_batch.v1": { required: ["batch_seq", "chain_payload", "chain_signature", "entries", "notary_card", "policy_id", "release_not_before", "type"] },
  "notary_list_approval": { required: ["governance_version", "kind", "list", "list_card", "list_hash", "list_version", "signatures", "type"], optional: ["prev_list_hash", "single_operator_quorums"] },
};

/** Reject an object whose `type` is not the expected one or whose top-level fields are not exactly the table's. */
export function assertNotaryObject(obj: unknown, expectedType: string): asserts obj is Record<string, unknown> {
  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) throw new NotaryFormatError("OBJECT_NOT_MAP", expectedType);
  const rec = obj as Record<string, unknown>;
  if (rec["type"] !== expectedType) throw new NotaryFormatError("TYPE_MISMATCH", `expected ${expectedType}, got ${String(rec["type"])}`);
  const spec = OBJECT_FIELDS[expectedType];
  if (!spec) throw new NotaryFormatError("TYPE_UNKNOWN", expectedType);
  assertExactFields(rec, spec.required, spec.optional ?? []);
}

/** Codes the notary checks add to the verifier (card_verifier.md §9; notary_lifecycle.md Error Paths). */
export const NOTARY_CODES = {
  GENESIS_INVALID: "NOTARY_GENESIS_INVALID",
  KEY_EXPOSED: "NOTARY_KEY_EXPOSED",
  LINEAGE_INCOMPLETE: "NOTARY_LINEAGE_INCOMPLETE",
  DERIVED_SHAPE: "NOTARY_DERIVED_SHAPE",
  CONFIG_MISSING: "NOTARY_CONFIG_MISSING",
} as const;
