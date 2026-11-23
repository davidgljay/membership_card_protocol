import { describe, it, expect } from "vitest";
import { loadConfig } from "../src/config.js";
import { providerProblems, simulatedComponents, chainIdProblem } from "../src/providers.js";

const key = Buffer.alloc(32, 7).toString("base64url");
const base: Record<string, string> = {
  NOTARY_CARD_ADDRESSES: "ab".repeat(32), NOTARY_HOST_MLDSA44_PRIVATE_KEY: key, NOTARY_OHTTP_PRIVATE_KEY: key, NOTARY_GAS_WALLET_PRIVATE_KEY: "11".repeat(32),
  ARBITRUM_RPC_URL: "http://rpc", EXPECTED_CHAIN_ID: "412346", REGISTRY_CONTRACT_ADDRESS: "0x" + "12".repeat(20), EAS_CONTRACT_ADDRESS: "0x" + "34".repeat(20),
  NOTARY_EAS_SCHEMA_UID: "0x" + "56".repeat(32), IPFS_PROVIDER: "kubo", KUBO_API_URL: "http://kubo:5001", EXTERNAL_KV_URL: "redis://redis:6379", ENCLAVE_CIDS: "16",
  ENCLAVE_ENDPOINTS: "16=127.0.0.1:7001", NOTARY_ADMIN_TOKEN: "x".repeat(40), NOTARY_RELAY_TARGET_ID: "notary-a", NOTARY_PUBLIC_BASE_URL: "https://n.example",
};
const rpc = { ...base, REGISTRY_STORAGE_ADDRESS: "0x" + "78".repeat(20), NOTARY_DELIVERY_URL: "http://wallet-service:3000" };
const sim = { ...base, CHAIN_PROVIDER: "sim", SIM_CHAIN_URL: "http://sim:8800", IPFS_PROVIDER: "sim" };

describe("provider selection (phase 5.7: no silent fallback to in-memory services)", () => {
  it("the production stack (rpc chain, Kubo) starts, and nothing in it is simulated", () => {
    const c = loadConfig(rpc);
    expect(providerProblems(c)).toEqual([]);
    expect(simulatedComponents(c)).toEqual([]);
  });
  it("the rpc chain never starts on in-memory or simulated IPFS (it would pin nothing a verifier could fetch)", () => {
    for (const ipfs of ["mock", "sim"]) {
      const env = { ...rpc, IPFS_PROVIDER: ipfs, ...(ipfs === "sim" ? { SIM_CHAIN_URL: "http://sim:8800" } : {}) };
      let p: string;
      try { p = providerProblems(loadConfig(env)).join("\n"); } catch (e) { p = (e as Error).message; }
      expect(p, ipfs).toMatch(/IPFS_PROVIDER/);
    }
  });
  it("Kubo is for the production chain only", () => {
    expect(providerProblems(loadConfig({ ...sim, IPFS_PROVIDER: "kubo" })).join("\n")).toContain("IPFS_PROVIDER=kubo is for the production chain");
  });
  it("the rpc chain needs the registry's storage contract and a delivery wallet service", () => {
    expect(() => loadConfig(base)).toThrow(/REGISTRY_STORAGE_ADDRESS is required[\s\S]*NOTARY_DELIVERY_URL is required/);
    expect(() => loadConfig({ ...rpc, REGISTRY_STORAGE_ADDRESS: "nope" })).toThrow(/REGISTRY_STORAGE_ADDRESS must be/);
  });
  it("the simulated stack starts, and names what is simulated", () => {
    const c = loadConfig({ ...sim, EXTERNAL_KV_URL: "redis://redis:6379" });
    expect(providerProblems(c)).toEqual([]);
    expect(simulatedComponents(c)).toEqual(["chain, EAS and registry (simulated)", "IPFS (simulated)"]);
  });
  it("the in-memory storage URL is for the simulated stack only", () => {
    expect(providerProblems(loadConfig({ ...rpc, EXTERNAL_KV_URL: "memory://" })).join("\n")).toContain("EXTERNAL_KV_URL=memory:");
    const c = loadConfig({ ...sim, EXTERNAL_KV_URL: "memory://" });
    expect(providerProblems(c)).toEqual([]);
    expect(simulatedComponents(c)).toContain("storage (in memory)");
  });
  it("the RPC's chain ID must be EXPECTED_CHAIN_ID", () => {
    expect(chainIdProblem(42161, 42161)).toBeNull();
    expect(chainIdProblem(421614, 42161)).toBe("ARBITRUM_RPC_URL is chain 421614, EXPECTED_CHAIN_ID is 42161");
  });
  it("GAS_BALANCE_LOW_WEI defaults to 0.01 ETH and must be an integer", () => {
    expect(loadConfig(rpc).GAS_BALANCE_LOW_WEI).toBe(10_000_000_000_000_000n);
    expect(loadConfig({ ...rpc, GAS_BALANCE_LOW_WEI: "5" }).GAS_BALANCE_LOW_WEI).toBe(5n);
    expect(() => loadConfig({ ...rpc, GAS_BALANCE_LOW_WEI: "1e16" })).toThrow(/GAS_BALANCE_LOW_WEI/);
  });
});
