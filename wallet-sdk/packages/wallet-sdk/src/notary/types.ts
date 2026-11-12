/**
 * Wallet-side notary objects (protocol-objects.md §21–§26).
 *
 * Implements: §21 NotaryJob, §22 JobAnnouncement, §23 NotaryInput, §23.1 NotaryCountersign,
 * §24 SealedInput, §25 HostReceipt, §26 ValidationReceipt.
 * Strictness (unknown fields rejected, `type` checked) is enforced by `assertNotaryObject`
 * from `@membership-card-protocol/verifier/notary`, against the same field table the vectors use.
 * Exposed to the notary host through the side-effect-free subpath `./notary-types` (Q4).
 */
import type { Base64Url, CardPointer, Cid, SignatureEntry, Timestamp } from "@membership-card-protocol/verifier/notary";

export type { Base64Url, CardPointer, Cid, SignatureEntry, Timestamp };

export interface ReplicaSetEntry { instances: number; notary_card: CardPointer }

/** §21 */
export interface NotaryJob {
  closes_at?: Timestamp;
  created_at: Timestamp;
  ends_at?: Timestamp;
  key_period?: string;
  kem: "x-wing-draft-06";
  min_live: number;
  nonce: Base64Url;
  opens_at: Timestamp;
  parameters: Record<string, unknown>;
  policy_id: Cid;
  policy_state_cid: Cid;
  replica_set: ReplicaSetEntry[];
  requester_card: CardPointer;
  requester_pubkey: Base64Url;
  requester_signature: SignatureEntry;
  requester_text?: string;
  type: "notary.job.v1";
}

/** §22 */
export interface JobAnnouncement {
  attestations: Cid[];
  epoch: number;
  epoch_reason?: "key_period" | "total_loss" | "runtime_migration" | "key_exposure";
  issued_at: Timestamp;
  job: NotaryJob;
  job_public_key: Base64Url;
  notary_signature: SignatureEntry;
  prev_announcement?: Cid;
  transport: { key_config_url: string; relay_target_id: string };
  type: "notary.announcement.v1";
}

/** §23 */
export interface NotaryInput {
  chain_ref: { block_hash: Base64Url; block_number: number };
  contributor_card: CardPointer;
  contributor_card_pubkey: Base64Url;
  contributor_signature: SignatureEntry;
  evidence: { bytes: Base64Url; cid: Cid }[];
  job_hash: Base64Url;
  payload: Record<string, unknown>;
  revision: number;
  signed_at: Timestamp;
  type: "notary.input.v1";
}

/** §23.1 */
export interface NotaryCountersign {
  holder_signature: Base64Url;
  job_hash: Base64Url;
  offer_hash: Base64Url;
  type: "notary.countersign.v1";
}

/** §24 */
export interface SealedInput {
  ct: Base64Url;
  enc: Base64Url;
  epoch: number;
  job_hash: Base64Url;
  kem: "x-wing-draft-06";
  type: "notary.sealed_input.v1";
}

/** §25 */
export interface HostReceipt {
  epoch: number;
  host_signature: SignatureEntry;
  input_hash: Base64Url;
  job_hash: Base64Url;
  notary_card: CardPointer;
  received_at: Timestamp;
  type: "notary.host_receipt.v1";
}

/** §26 */
export interface ValidationReceipt {
  acks: number;
  derived_offer?: Record<string, unknown>;
  epoch: number;
  input_hash: Base64Url;
  instance: Base64Url;
  job_hash: Base64Url;
  notary_signature: SignatureEntry;
  processed_at: Timestamp;
  reject_reason?: string;
  revision: number;
  status: "accepted" | "rejected" | "superseded";
  type: "notary.validation_receipt.v1";
}
