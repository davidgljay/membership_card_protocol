import { describe, it, expect } from "vitest";
import { loadConfig, ConfigError } from "../src/config.js";

const key = Buffer.alloc(32, 7).toString("base64url");
const good: Record<string, string> = {
  NOTARY_CARD_ADDRESSES: "ab".repeat(32), NOTARY_HOST_MLDSA44_PRIVATE_KEY: key, NOTARY_OHTTP_PRIVATE_KEY: key, NOTARY_GAS_WALLET_PRIVATE_KEY: "11".repeat(32),
  ARBITRUM_RPC_URL: "http://rpc", EXPECTED_CHAIN_ID: "412346", REGISTRY_CONTRACT_ADDRESS: "0x" + "12".repeat(20), EAS_CONTRACT_ADDRESS: "0x" + "34".repeat(20),
  NOTARY_EAS_SCHEMA_UID: "0x" + "56".repeat(32), IPFS_PROVIDER: "mock", EXTERNAL_KV_URL: "redis://redis:6379", ENCLAVE_CIDS: "16,17",
  ENCLAVE_ENDPOINTS: "16=127.0.0.1:7001,17=unix:/run/enclave-17.sock", NOTARY_ADMIN_TOKEN: "x".repeat(40), NOTARY_RELAY_TARGET_ID: "notary-a", NOTARY_PUBLIC_BASE_URL: "https://n.example",
};

describe("host configuration (notary_host.md §4)", () => {
  it("loads a complete configuration with the documented defaults", () => {
    const c = loadConfig(good);
    expect(c.SNAPSHOT_REFRESH_SECONDS).toBe(30);
    expect(c.REATTEST_INTERVAL_SECONDS).toBe(21600);
    expect(c.ENCLAVE_ENDPOINTS).toEqual([{ cid: "16", address: { host: "127.0.0.1", port: 7001 } }, { cid: "17", address: { unix: "/run/enclave-17.sock" } }]);
    expect(c.NOTARY_HOST_MLDSA44_SEED.length).toBe(32);
    expect(c.PEER_HOSTS).toEqual([]);
  });
  it("reports every problem at once", () => {
    try { loadConfig({}); throw new Error("should have thrown"); } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      const p = (e as ConfigError).problems.join("\n");
      for (const k of ["NOTARY_HOST_MLDSA44_PRIVATE_KEY", "NOTARY_OHTTP_PRIVATE_KEY", "NOTARY_GAS_WALLET_PRIVATE_KEY", "ARBITRUM_RPC_URL", "REGISTRY_CONTRACT_ADDRESS",
        "EAS_CONTRACT_ADDRESS", "NOTARY_EAS_SCHEMA_UID", "IPFS_PROVIDER", "EXTERNAL_KV_URL", "ENCLAVE_CIDS", "NOTARY_ADMIN_TOKEN"]) expect(p, k).toContain(k);
    }
  });
  it("rejects malformed values", () => {
    const bad = (o: Record<string, string>) => () => loadConfig({ ...good, ...o });
    expect(bad({ NOTARY_CARD_ADDRESSES: "NOTHEX" })).toThrow(/64 lowercase hex/);
    expect(bad({ NOTARY_HOST_MLDSA44_PRIVATE_KEY: "short" })).toThrow(/32 bytes/);
    expect(bad({ NOTARY_GAS_WALLET_PRIVATE_KEY: "zz" })).toThrow(/32 bytes of hex/);
    expect(bad({ REGISTRY_CONTRACT_ADDRESS: "0x12" })).toThrow(/20-byte/);
    expect(bad({ NOTARY_EAS_SCHEMA_UID: "0x12" })).toThrow(/64 hex/);
    expect(bad({ IPFS_PROVIDER: "kubo" })).toThrow(/KUBO_API_URL/);
    expect(bad({ ENCLAVE_ENDPOINTS: "16=127.0.0.1:7001" })).toThrow(/17 has no ENCLAVE_ENDPOINTS/);
    expect(bad({ ENCLAVE_ENDPOINTS: "nonsense" })).toThrow(/must be cid=/);
    expect(bad({ NOTARY_ADMIN_TOKEN: "short" })).toThrow(/at least 32/);
    expect(bad({ SNAPSHOT_REFRESH_SECONDS: "-1" })).toThrow(/positive integer/);
  });
});
