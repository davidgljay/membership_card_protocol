/**
 * Which service implementations this host can start with (phase 5.7 review).
 *
 * Two stacks start: the simulated one (`CHAIN_PROVIDER=sim`, `IPFS_PROVIDER=sim`) and the production one
 * (`CHAIN_PROVIDER=rpc` with `IPFS_PROVIDER=kubo`, over the Phase 7 chain, EAS, gas-wallet, Kubo and delivery clients,
 * `src/chain/rpc.ts`). Nothing else: the host must never fall back to the in-memory test services, which would issue
 * anchor receipts for records nothing anchored and pin nothing. The same goes for the `memory:` storage URL, which
 * loses every ciphertext and receipt at restart.
 */
import type { HostConfig } from "./config.js";

/** Reasons this configuration cannot start. Empty when it can. */
export function providerProblems(c: HostConfig): string[] {
  const problems: string[] = [];
  if (c.CHAIN_PROVIDER === "rpc" && c.IPFS_PROVIDER !== "kubo") {
    problems.push(`CHAIN_PROVIDER=rpc requires IPFS_PROVIDER=kubo (got ${c.IPFS_PROVIDER}): the in-memory and simulated IPFS services would pin nothing a verifier could fetch.`);
  }
  if (c.CHAIN_PROVIDER === "sim" && c.IPFS_PROVIDER === "kubo") {
    problems.push("IPFS_PROVIDER=kubo is for the production chain (CHAIN_PROVIDER=rpc); the simulated chain has its own IPFS (IPFS_PROVIDER=sim).");
  }
  if (c.CHAIN_PROVIDER === "rpc" && (!c.REGISTRY_STORAGE_ADDRESS || !c.NOTARY_DELIVERY_URL)) {
    problems.push("CHAIN_PROVIDER=rpc needs REGISTRY_STORAGE_ADDRESS and NOTARY_DELIVERY_URL.");
  }
  if (c.EXTERNAL_KV_URL.startsWith("memory:") && c.CHAIN_PROVIDER !== "sim") {
    problems.push("EXTERNAL_KV_URL=memory: keeps nothing across restarts and is for the simulated stack only (CHAIN_PROVIDER=sim).");
  }
  return problems;
}

/** Components of this configuration that are simulated or in memory, for a warning at startup. */
export function simulatedComponents(c: HostConfig): string[] {
  const out: string[] = [];
  if (c.CHAIN_PROVIDER === "sim") out.push("chain, EAS and registry (simulated)");
  if (c.IPFS_PROVIDER === "sim") out.push("IPFS (simulated)");
  if (c.IPFS_PROVIDER === "mock") out.push("IPFS (in memory)");
  if (c.EXTERNAL_KV_URL.startsWith("memory:")) out.push("storage (in memory)");
  return out;
}

/** The RPC must be the chain this host was configured for (`EXPECTED_CHAIN_ID`): a wrong endpoint is caught at start, not by a job. */
export function chainIdProblem(actual: number, expected: number): string | null {
  return actual === expected ? null : `ARBITRUM_RPC_URL is chain ${actual}, EXPECTED_CHAIN_ID is ${expected}`;
}
