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
  submit(s: { op: string; payload: unknown; signature: string; calldata: string }): Promise<{ txHash: string } | { failed: string }>;
}

/** Policy reads for job intake (the policy's `notary` section at a state). Backed by the chain feed. */
export interface PolicyReader {
  notary(policyId: string, stateCid: string): Promise<{ notary: NotarySection; approvedNotaries: string[] } | null>;
}

/** Per-card chain reads, answered only for ancestors outside snapshotted policies and the disclosed fallback. */
export interface ChainReader {
  cardHead(address: string): Promise<Uint8Array | null>;
  pressAuth(policy: string, press: string): Promise<unknown | null>;
  subcard(address: string): Promise<unknown | null>;
  events(filter: string): Promise<unknown | null>;
}

export interface PeerClient { send(hostUrl: string, body: { to_instance: string; from_instance: string; bytes: string }): Promise<void> }
export interface DeliveryClient { deliver(routingEnvelope: unknown): Promise<void> }
/** Starts and attests a new enclave, preferably in another availability zone. */
export interface ReplicaStarter { start(forJob: string | null, notaryCard: string | null): Promise<void> }

/** Operator alerts. They never carry job data: only a level, a code and counts. */
export interface Monitor { alert(level: "info" | "warn" | "error", code: string, counts?: Record<string, number>): Promise<void> }
