/**
 * EAS anchors under the notary job-log schema (card_verifier.md §4.1 `getNotaryLogAnchors`; protocol-objects.md §28).
 *
 * EAS's `Attested` event indexes only `recipient`, `attester` and `schemaUID`, not the schema's own fields
 * (errata E3, accepted), so the lookup reads every attestation under the notary schema from a start block and
 * filters by the scope client-side. The schema is `{ job_hash, seq, record_cid }`; its ABI types are not fixed by
 * the spec (erratum E16): the default is `(bytes32 job_hash, uint64 seq, string record_cid)`, configurable.
 *
 * `scopeId` is a `job_hash` (base64url, 32 bytes) for a job log, or a notary card address (64 lowercase hex)
 * for an identity log; both are 32 bytes and are compared as bytes32.
 */
import { AbiCoder, Contract, hexlify } from "ethers";
import type { Provider } from "ethers";

export interface EasReader {
  /** `Attested` events under the notary schema from `fromBlock`: attestation uid and block number. */
  attestedUids(schemaUid: string, fromBlock: number): Promise<{ uid: string; blockNumber: number }[]>;
  /** The attestation's ABI-encoded `data` (and whether it was revoked). */
  attestationData(uid: string): Promise<{ data: string; revoked: boolean }>;
  /** Block timestamp in seconds. */
  blockTimestamp(blockNumber: number): Promise<number>;
}

export interface NotaryAnchorOptions {
  schemaUid: string;
  /** First block to scan (the job's `opened` anchor, or the EAS schema registration block). */
  fromBlock: number;
  /** ABI types of the schema fields, in order: job_hash, seq, record_cid. */
  schemaTypes?: [string, string, string];
}

export function scopeToBytes32(scopeId: string): string {
  if (/^[0-9a-f]{64}$/.test(scopeId)) return "0x" + scopeId;
  if (/^[A-Za-z0-9_-]{43}$/.test(scopeId)) return hexlify(Uint8Array.from(Buffer.from(scopeId, "base64url")));
  throw new Error(`notary log scope must be a 32-byte job_hash (base64url) or a card address (64 hex): ${scopeId}`);
}

export async function collectNotaryLogAnchors(reader: EasReader, scopeId: string, o: NotaryAnchorOptions):
  Promise<{ seq: number; record_cid: string; timestamp: number }[]> {
  const scope = scopeToBytes32(scopeId).toLowerCase();
  const types = o.schemaTypes ?? ["bytes32", "uint64", "string"];
  const coder = AbiCoder.defaultAbiCoder();
  const out: { seq: number; record_cid: string; timestamp: number; block: number; uid: string }[] = [];
  for (const ev of await reader.attestedUids(o.schemaUid, o.fromBlock)) {
    const { data, revoked } = await reader.attestationData(ev.uid);
    if (revoked) continue;
    let decoded: unknown[];
    try { decoded = [...coder.decode(types, data)]; } catch { continue; }
    if (String(decoded[0]).toLowerCase() !== scope) continue;
    out.push({ seq: Number(decoded[1]), record_cid: String(decoded[2]), timestamp: (await reader.blockTimestamp(ev.blockNumber)) * 1000, block: ev.blockNumber, uid: ev.uid });
  }
  // chain order: block, then uid for a stable order within a block
  out.sort((a, b) => a.block - b.block || a.uid.localeCompare(b.uid));
  return out.map(({ seq, record_cid, timestamp }) => ({ seq, record_cid, timestamp }));
}

const EAS_ABI = [
  "event Attested(address indexed recipient, address indexed attester, bytes32 uid, bytes32 indexed schemaUID)",
  "function getAttestation(bytes32 uid) view returns (tuple(bytes32 uid, bytes32 schema, uint64 time, uint64 expirationTime, uint64 revocationTime, bytes32 refUID, address recipient, address attester, bool revocable, bytes data))",
];

/** `EasReader` over an ethers v6 provider and the EAS contract. Untested against a chain until Phase 7 (the devnode stack). */
export class EthersEasReader implements EasReader {
  readonly #eas: Contract;
  readonly #provider: Provider;
  constructor(provider: Provider, easAddress: string) {
    this.#provider = provider;
    this.#eas = new Contract(easAddress, EAS_ABI, provider);
  }
  async attestedUids(schemaUid: string, fromBlock: number) {
    const logs = await this.#eas.queryFilter(this.#eas.filters["Attested"]!(null, null, null, schemaUid), fromBlock);
    return logs.map((l) => ({ uid: String((l as unknown as { args: { uid: string } }).args.uid), blockNumber: l.blockNumber }));
  }
  async attestationData(uid: string) {
    const a = await this.#eas.getFunction("getAttestation")(uid) as { data: string; revocationTime: bigint };
    return { data: a.data, revoked: a.revocationTime !== 0n };
  }
  async blockTimestamp(blockNumber: number) {
    const b = await this.#provider.getBlock(blockNumber);
    if (!b) throw new Error(`block ${blockNumber} not found`);
    return b.timestamp;
  }
}

