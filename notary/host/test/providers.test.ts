import { describe, it, expect } from "vitest";
import { loadConfig } from "../src/config.js";
import { providerProblems, simulatedComponents } from "../src/providers.js";

const key = Buffer.alloc(32, 7).toString("base64url");
const base: Record<string, string> = {
  NOTARY_CARD_ADDRESSES: "ab".repeat(32), NOTARY_HOST_MLDSA44_PRIVATE_KEY: key, NOTARY_OHTTP_PRIVATE_KEY: key, NOTARY_GAS_WALLET_PRIVATE_KEY: "11".repeat(32),
  ARBITRUM_RPC_URL: "http://rpc", EXPECTED_CHAIN_ID: "412346", REGISTRY_CONTRACT_ADDRESS: "0x" + "12".repeat(20), EAS_CONTRACT_ADDRESS: "0x" + "34".repeat(20),
  NOTARY_EAS_SCHEMA_UID: "0x" + "56".repeat(32), IPFS_PROVIDER: "kubo", KUBO_API_URL: "http://kubo:5001", EXTERNAL_KV_URL: "redis://redis:6379", ENCLAVE_CIDS: "16",
  ENCLAVE_ENDPOINTS: "16=127.0.0.1:7001", NOTARY_ADMIN_TOKEN: "x".repeat(40), NOTARY_RELAY_TARGET_ID: "notary-a", NOTARY_PUBLIC_BASE_URL: "https://n.example",
};
const sim = { ...base, CHAIN_PROVIDER: "sim", SIM_CHAIN_URL: "http://sim:8800", IPFS_PROVIDER: "sim" };

describe("provider selection (phase 5.7: no silent fallback to in-memory services)", () => {
  it("a production configuration refuses to start until the Phase 7 clients exist", () => {
    const p = providerProblems(loadConfig(base)).join("\n");
    expect(p).toContain("CHAIN_PROVIDER=rpc");
    expect(p).toContain("IPFS_PROVIDER=kubo");
  });
  it("the simulated stack starts, and names what is simulated", () => {
    const c = loadConfig({ ...sim, EXTERNAL_KV_URL: "redis://redis:6379" });
    expect(providerProblems(c)).toEqual([]);
    expect(simulatedComponents(c)).toEqual(["chain, EAS and registry (simulated)", "IPFS (simulated)"]);
  });
  it("the in-memory storage URL is for the simulated stack only", () => {
    expect(providerProblems(loadConfig({ ...base, IPFS_PROVIDER: "mock", EXTERNAL_KV_URL: "memory://" })).join("\n")).toContain("EXTERNAL_KV_URL=memory:");
    const c = loadConfig({ ...sim, EXTERNAL_KV_URL: "memory://" });
    expect(providerProblems(c)).toEqual([]);
    expect(simulatedComponents(c)).toContain("storage (in memory)");
  });
});
