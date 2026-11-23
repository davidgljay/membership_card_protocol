/**
 * Interfaces for everything the host talks to. Production implementations arrive with the integration stack
 * (Phase 7); tests use the in-memory ones in `src/testing.ts`. Keeping them as interfaces is also what keeps the
 * host honest about its trust position (notary_host.md §2): it relays and records, it never decides.
 */
import type { NotarySection } from "@membership-card-protocol/verifier/notary";

/** Pinning of **exact** bytes with the `raw` codec (notary_host.md §9); returns the CIDv1. */
export interface IpfsService {
  pin(bytes: Uint8Array): Promise<string>;
  fetch(cid: string): Promise<Uint8Array | null>;
}

/** EAS anchoring of job-log records under the notary schema (notary_host.md §9). */
export interface EasAnchorer {
  anchor(a: { scopeId: string; seq: number; recordCid: string }): Promise<{ txHash: string }>;
}

/** Registry writes of enclave-signed payloads, submitted from the gas wallet **unchanged** (notary_host.md §10). */
export interface ChainSubmitter {
  /** `calldata`: the logical arguments the enclave named (for `register_card`: `{ card_address, initial_log_cid, policy_address, press_address }`, unpadded base64url, the encodings the write gate compares). */
  submit(s: { op: string; payload: unknown; signature: string; calldata: unknown }): Promise<{ txHash: string } | { failed: string }>;
}

/** Policy reads for job intake (the policy's `notary` section at a state). Backed by the chain feed. */
export interface PolicyReader {
  notary(policyId: string, stateCid: string): Promise<{ notary: NotarySection; approvedNotaries: string[] } | null>;
}

/** The gas wallet's balance, for the `gas_balance_low` alert (notary_host.md §13). */
export interface GasReader { balanceWei(): Promise<bigint> }

/** Per-card chain reads, answered only for ancestors outside snapshotted policies and the disclosed fallback. */
export interface ChainReader {
  cardHead(address: string): Promise<Uint8Array | null>;
  /** `PressAuthorizations[policy][press]`: `{ next_sequence, active, press_public_key }`. A derived-card enclave signs its registrations with `next_sequence`. */
  pressAuth(policy: string, press: string): Promise<unknown | null>;
  /** The registry's `getProtocolVersion()`, which a derived card carries (protocol-objects §1). */
  protocolVersion(): Promise<string | null>;
  subcard(address: string): Promise<unknown | null>;
  events(filter: string): Promise<unknown | null>;
}

/** Calls a peer host's `POST /peer` (notary_host.md §11). `send` relays an envelope; `request` carries the other kinds and returns the JSON answer. */
export interface PeerClient {
  send(hostUrl: string, body: { to_instance: string; from_instance: string; bytes: string }): Promise<void>;
  request(hostUrl: string, body: Record<string, unknown>): Promise<unknown>;
}
export interface DeliveryClient { deliver(routingEnvelope: unknown): Promise<void> }
/** Starts and attests a new enclave, preferably in another availability zone. */
export interface ReplicaStarter { start(forJob: string | null, notaryCard: string | null): Promise<void> }

/** Operator alerts. They never carry job data: only a level, a code and counts. */
export interface Monitor { alert(level: "info" | "warn" | "error", code: string, counts?: Record<string, number>): Promise<void> }

/** The chain feed behind the host's schedulers (notary_host.md §8): new block headers and the registry's events. */
export interface ChainFeed {
  /** Headers after block `n`, oldest first: `header_rlp` base64url, `timestamp` in seconds. */
  headersAfter(n: number): Promise<{ number: number; header_rlp: string; timestamp: number }[]>;
  /** Every `CardRegistered` / `CardHeadUpdated` under `policy`, every sub-card registration, and the newest block. */
  registry(policy: string): Promise<{ events: import("./chain/snapshots.js").RegistryEvent[]; subcards: import("./chain/snapshots.js").SubCardEvent[]; block: number; /** the policy card's current head, when the registry knows it */ policyHead?: string | null }>;
}
