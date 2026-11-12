/**
 * EAS anchoring (notary_host.md §9). For every record of an anchored kind the host submits an attestation
 * `{ job_hash, seq, record_cid }` under the notary schema from the gas wallet, then returns the transaction receipt
 * to the enclave (`anchor_receipt`). The enclave signs nothing further in that log until it sees the receipt, so
 * the host cannot skip a record without stopping the job.
 *
 * ABI encoding of the schema data (erratum E16): default `(bytes32 job_hash, uint64 seq, string record_cid)`.
 * Viem client wiring (gas wallet, EAS `attest`) is Phase 7; the encoding below is what both sides must share.
 */
import { encodeAbiParameters } from "viem";
import type { EasAnchorer } from "../services.js";

export const NOTARY_SCHEMA_TYPES = ["bytes32", "uint64", "string"] as const;

export function scopeToBytes32(scopeId: string): string {
  if (/^[0-9a-f]{64}$/.test(scopeId)) return "0x" + scopeId;
  if (/^[A-Za-z0-9_-]{43}$/.test(scopeId)) return "0x" + Buffer.from(scopeId, "base64url").toString("hex");
  throw new Error("scope must be a job_hash (base64url) or a notary card address (64 hex)");
}

export function encodeAnchorData(a: { scopeId: string; seq: number; recordCid: string }): string {
  return encodeAbiParameters([{ type: "bytes32" }, { type: "uint64" }, { type: "string" }], [scopeToBytes32(a.scopeId) as `0x${string}`, BigInt(a.seq), a.recordCid]);
}

/** An `EasAnchorer` over an injected attest function (the viem call in production). */
export function easAnchorer(attest: (schemaUid: string, data: string) => Promise<{ txHash: string }>, schemaUid: string): EasAnchorer {
  return { anchor: (a) => attest(schemaUid, encodeAnchorData(a)) };
}
