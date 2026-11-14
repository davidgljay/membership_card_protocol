/**
 * Which service implementations this host can start with (phase 5.7 review).
 *
 * The production chain, EAS, gas-wallet and Kubo clients are Phase 7. Until they exist the only runnable stack is
 * the simulated one (`CHAIN_PROVIDER=sim`). A host configured for production (`CHAIN_PROVIDER=rpc`,
 * `IPFS_PROVIDER=kubo`) must therefore refuse to start. It must never fall back to the in-memory test services:
 * those would issue anchor receipts for records nothing anchored, and pin nothing. The same goes for the
 * `memory:` storage URL, which loses every ciphertext and receipt at restart.
 */
import type { HostConfig } from "./config.js";

/** Reasons this configuration cannot start. Empty when it can. */
export function providerProblems(c: HostConfig): string[] {
  const problems: string[] = [];
  if (c.CHAIN_PROVIDER === "rpc") {
    problems.push("CHAIN_PROVIDER=rpc: the production chain, EAS and gas-wallet clients are not implemented yet (Phase 7). This host starts only against the simulated chain (CHAIN_PROVIDER=sim).");
  }
  if (c.IPFS_PROVIDER === "kubo") {
    problems.push("IPFS_PROVIDER=kubo: the Kubo client is not implemented yet (Phase 7). Use IPFS_PROVIDER=sim or mock with the simulated chain.");
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
