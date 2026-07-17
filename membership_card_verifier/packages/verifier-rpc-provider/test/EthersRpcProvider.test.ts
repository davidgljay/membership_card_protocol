import { describe, it, expect, vi } from "vitest";
import { EthersRpcProvider, type RegistryContract } from "../src/index.js";

function mockContract(overrides: Partial<RegistryContract> = {}): RegistryContract {
  return {
    getCardEntry: vi.fn().mockResolvedValue({ log_head_cid: "QmLog", policy_address: "0xpol", last_press_address: "0xpress", forward_to: null, exists: true }),
    isPolicyAuthorizer: vi.fn().mockResolvedValue(false),
    getPressAuthorization: vi.fn().mockResolvedValue(null),
    getSubCardEntry: vi.fn().mockResolvedValue(null),
    getCardEventLog: vi.fn().mockResolvedValue([]),
    getEasAnnotations: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
}

describe("EthersRpcProvider", () => {
  it("getCardEntry delegates to contract and returns entry", async () => {
    const contract = mockContract();
    const provider = new EthersRpcProvider(contract);
    const result = await provider.getCardEntry("0xabc");
    expect(contract.getCardEntry).toHaveBeenCalledWith("0xabc");
    expect(result?.log_head_cid).toBe("QmLog");
  });

  it("getCardEntry returns null if exists is false", async () => {
    const contract = mockContract({
      getCardEntry: vi.fn().mockResolvedValue({ log_head_cid: "", policy_address: "", last_press_address: "", forward_to: null, exists: false }),
    });
    const provider = new EthersRpcProvider(contract);
    expect(await provider.getCardEntry("0xnone")).toBeNull();
  });

  it("isPolicyAuthorizer delegates to contract", async () => {
    const contract = mockContract({ isPolicyAuthorizer: vi.fn().mockResolvedValue(true) });
    const provider = new EthersRpcProvider(contract);
    expect(await provider.isPolicyAuthorizer("0xroot")).toBe(true);
  });

  it("getPressAuthorization returns null when none exists", async () => {
    const contract = mockContract({ getPressAuthorization: vi.fn().mockResolvedValue(null) });
    const provider = new EthersRpcProvider(contract);
    expect(await provider.getPressAuthorization("0xpol", "0xpress")).toBeNull();
  });

  it("getSubCardEntry returns null when not registered", async () => {
    const contract = mockContract({ getSubCardEntry: vi.fn().mockResolvedValue(null) });
    const provider = new EthersRpcProvider(contract);
    expect(await provider.getSubCardEntry("0xsub")).toBeNull();
  });

  it("getCardEventLog returns empty array", async () => {
    const contract = mockContract();
    const provider = new EthersRpcProvider(contract);
    expect(await provider.getCardEventLog("0xcard")).toEqual([]);
  });

  it("getCardEventLog delegates the on-chain event replay from the contract", async () => {
    const contract = mockContract({
      getCardEventLog: vi.fn().mockResolvedValue([
        { cid: "QmGenesis", timestamp: "2026-05-01T00:00:00Z" },
        { cid: "QmUpdate", timestamp: "2026-06-01T00:00:00Z" },
      ]),
    });
    const provider = new EthersRpcProvider(contract);
    const result = await provider.getCardEventLog("0xcard");
    expect(contract.getCardEventLog).toHaveBeenCalledWith("0xcard");
    expect(result).toEqual([
      { cid: "QmGenesis", timestamp: "2026-05-01T00:00:00Z" },
      { cid: "QmUpdate", timestamp: "2026-06-01T00:00:00Z" },
    ]);
  });

  it("getEasAnnotations delegates with address list", async () => {
    const contract = mockContract({
      getEasAnnotations: vi.fn().mockResolvedValue([{ uid: "0xuid", attester: "0xatt", cid: "QmAnn", update_code: 400, effective_date: "2026-06-20T00:00:00Z" }]),
    });
    const provider = new EthersRpcProvider(contract);
    const result = await provider.getEasAnnotations("0xcard", ["0xatt"]);
    expect(result).toHaveLength(1);
    expect(result[0]?.uid).toBe("0xuid");
  });
});
