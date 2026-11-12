import { describe, it, expect, vi } from "vitest";
import { AbiCoder } from "ethers";
import { EthersRpcProvider, collectNotaryLogAnchors, scopeToBytes32, type EasReader, type RegistryContract } from "../src/index.js";

const coder = AbiCoder.defaultAbiCoder();
const b32 = (n: number) => "0x" + n.toString(16).padStart(2, "0").repeat(32);
const enc = (job: string, seq: number, cid: string) => coder.encode(["bytes32", "uint64", "string"], [job, seq, cid]);

type Row = { uid: string; block: number; job: string; seq: number; cid: string; revoked?: boolean };
function reader(rows: Row[]): EasReader {
  return {
    attestedUids: async (_s, from) => rows.filter((r) => r.block >= from).map((r) => ({ uid: r.uid, blockNumber: r.block })),
    attestationData: async (uid) => { const r = rows.find((x) => x.uid === uid)!; return { data: enc(r.job, r.seq, r.cid), revoked: r.revoked ?? false }; },
    blockTimestamp: async (b) => 1_700_000_000 + b,
  };
}
const OPTS = { schemaUid: b32(9), fromBlock: 0 };

describe("getNotaryLogAnchors (EAS client-side filtering, errata E3/E16)", () => {
  const rows: Row[] = [
    { uid: "0x01", block: 10, job: b32(1), seq: 0, cid: "cid-a0" },
    { uid: "0x02", block: 12, job: b32(2), seq: 0, cid: "cid-b0" }, // another job
    { uid: "0x03", block: 15, job: b32(1), seq: 1, cid: "cid-a1" },
    { uid: "0x04", block: 11, job: b32(1), seq: 0, cid: "cid-a0-fork" }, // a fork: same seq, other record
    { uid: "0x05", block: 20, job: b32(1), seq: 2, cid: "cid-revoked", revoked: true },
  ];
  it("returns only the scope's anchors, in chain order, with block timestamps in milliseconds; revoked ones are skipped", async () => {
    const jobB64u = Buffer.from(new Uint8Array(32).fill(1)).toString("base64url");
    const a = await collectNotaryLogAnchors(reader(rows), jobB64u, OPTS);
    expect(a).toEqual([
      { seq: 0, record_cid: "cid-a0", timestamp: (1_700_000_000 + 10) * 1000 },
      { seq: 0, record_cid: "cid-a0-fork", timestamp: (1_700_000_000 + 11) * 1000 },
      { seq: 1, record_cid: "cid-a1", timestamp: (1_700_000_000 + 15) * 1000 },
    ]);
  });
  it("accepts a notary card address (64 hex) as the scope for identity logs", async () => {
    const a = await collectNotaryLogAnchors(reader(rows), "02".repeat(32), OPTS);
    expect(a.map((x) => x.record_cid)).toEqual(["cid-b0"]);
  });
  it("honours fromBlock and ignores attestations that do not decode under the schema", async () => {
    expect((await collectNotaryLogAnchors(reader(rows), "01".repeat(32), { ...OPTS, fromBlock: 12 })).map((x) => x.seq)).toEqual([1]);
    const junk: EasReader = { ...reader(rows), attestationData: async () => ({ data: "0x1234", revoked: false }) };
    expect(await collectNotaryLogAnchors(junk, "01".repeat(32), OPTS)).toEqual([]);
  });
  it("rejects a scope that is neither a job_hash nor a card address", () => {
    expect(() => scopeToBytes32("not a scope")).toThrow();
    expect(scopeToBytes32("ab".repeat(32))).toBe("0x" + "ab".repeat(32));
  });
  it("EthersRpcProvider forwards, and refuses without an EAS reader", async () => {
    const contract = {} as RegistryContract;
    await expect(new EthersRpcProvider(contract).getNotaryLogAnchors("01".repeat(32))).rejects.toThrow(/eas/);
    const p = new EthersRpcProvider(contract, { eas: reader(rows), notaryAnchors: OPTS });
    expect((await p.getNotaryLogAnchors("01".repeat(32))).length).toBe(3);
  });
});

describe("getGovernanceKeyset", () => {
  const flat = (n: number, len: number) => Array.from({ length: n * len }, (_, i) => i % 251);
  const contractWith = (r: object): RegistryContract => ({ getGovernanceKeyset: vi.fn().mockResolvedValue(r) } as unknown as RegistryContract);
  it("splits the flat key array into 64-byte keys for scheme 0 and passes the PressRegistryBody id", async () => {
    const c = contractWith({ keys: flat(5, 64), key_count: 5n, quorum: 4n, version: 3n, key_scheme: 0n });
    const ks = await new EthersRpcProvider(c).getGovernanceKeyset("PressRegistryBody");
    expect(c.getGovernanceKeyset).toHaveBeenCalledWith(1);
    expect(ks).toMatchObject({ quorum: 4, version: 3, key_scheme: 0 });
    expect(ks.keys.length).toBe(5);
    expect(ks.keys[1]!.length).toBe(64);
    expect(ks.keys[1]![0]).toBe(64 % 251);
  });
  it("uses 1312-byte keys for scheme 1, and accepts a hex string", async () => {
    const bytes = new Uint8Array(2 * 1312).fill(7);
    const ks = await new EthersRpcProvider(contractWith({ keys: "0x" + Buffer.from(bytes).toString("hex"), key_count: 2, quorum: 2, version: 4, key_scheme: 1 })).getGovernanceKeyset("PressRegistryBody");
    expect(ks.keys.map((k) => k.length)).toEqual([1312, 1312]);
  });
  it("rejects inconsistent key bytes, unknown schemes and a missing contract method", async () => {
    await expect(new EthersRpcProvider(contractWith({ keys: flat(2, 64), key_count: 3, quorum: 2, version: 1, key_scheme: 0 })).getGovernanceKeyset("PressRegistryBody")).rejects.toThrow(/key bytes/);
    await expect(new EthersRpcProvider(contractWith({ keys: [], key_count: 0, quorum: 1, version: 1, key_scheme: 5 })).getGovernanceKeyset("PressRegistryBody")).rejects.toThrow(/key_scheme/);
    await expect(new EthersRpcProvider({} as RegistryContract).getGovernanceKeyset("PressRegistryBody")).rejects.toThrow(/not available/);
  });
});
