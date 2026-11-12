/**
 * Host- and enclave-only notary objects (protocol-objects.md §29–§32), plus the job-log record (§28)
 * the host stores and anchors. Most of these reach the host as opaque bytes; the types are for the
 * fields the host must read (anchor gating, heartbeats, relaying).
 *
 * §21–§26 come from the wallet SDK's side-effect-free `notary-types` subpath (Q4);
 * the verifier-facing objects (§20, §27, §28, §33, §34) from `@membership-card-protocol/verifier/notary`.
 */
import type { Base64Url, Cid, CardPointer, Timestamp, SignatureEntry, JobLogRecord } from "@membership-card-protocol/verifier/notary";

export type { JobLogRecord };

/** §29 */
export interface HandoffRecord {
  at: Timestamp;
  epoch?: number;
  from_attestation: Cid;
  from_instance: Base64Url;
  job_hash?: Base64Url;
  key_generation?: number;
  pcr0_from: Base64Url;
  pcr0_to: Base64Url;
  receiver_signature: SignatureEntry;
  scope: "job" | "identity" | "template";
  state_hash: Base64Url;
  state_version: number;
  to_attestation: Cid;
  to_instance: Base64Url;
  to_notary_card: CardPointer;
  type: "notary.handoff.v1";
}

/** §30 */
export interface Heartbeat {
  chain_head: { block_hash: Base64Url; block_number: number };
  identity_state_version?: number;
  instance: Base64Url;
  instance_signature: SignatureEntry;
  jobs: { epoch: number; job_hash: Base64Url; state_version: number }[];
  list_versions: { accepted_runtimes: number; program_allowlist: number };
  peers_seen: Base64Url[];
  seq: number;
  type: "notary.heartbeat.v1";
}

/** §31 */
export interface StateBlobHeader {
  at: Timestamp;
  body_cid: Cid;
  body_hash: Base64Url;
  notary_card: CardPointer;
  notary_signature: SignatureEntry;
  prev_hash?: Base64Url;
  type: "notary.state_blob.v1";
  version: number;
}

/** §32 */
export interface PropagationBatch {
  batch_seq: number;
  chain_payload: Record<string, unknown>;
  chain_signature: Base64Url;
  entries: { card_address: CardPointer; log_entry_cid: Cid; prev_log_cid: Cid }[];
  notary_card: CardPointer;
  policy_id: Cid;
  release_not_before: Timestamp;
  type: "notary.propagation_batch.v1";
}

/** Anchored job-log record kinds (§28): the host must anchor each before the enclave signs the next. */
export const ANCHORED_KINDS = ["opened", "epoch_started", "handoff", "replica_lost", "notarized", "issued", "aborted"] as const;
