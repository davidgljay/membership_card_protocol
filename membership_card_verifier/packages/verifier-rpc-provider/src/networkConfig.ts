/**
 * Network configuration for the Card Protocol verifier.
 *
 * Set the ENV environment variable before running the verifier:
 *   ENV=dev   → Arbitrum Sepolia (testnet, uses storage contract from deployments/sepolia.json)
 *   ENV=prod  → Arbitrum One (mainnet — update storageContractAddress when deployed)
 *
 * The RPC URL is read from ARBITRUM_SEPOLIA_RPC or ARBITRUM_MAINNET_RPC environment
 * variables respectively, with public endpoints as fallbacks.
 */

export type NetworkEnv = "dev" | "prod";

export interface NetworkConfig {
  /** JSON-RPC endpoint URL for the Arbitrum network. */
  rpcUrl: string;
  /** Address of the immutable Card Protocol storage contract. */
  storageContractAddress: string;
}

const NETWORK_CONFIGS: Record<NetworkEnv, NetworkConfig> = {
  dev: {
    rpcUrl: process.env["ARBITRUM_SEPOLIA_RPC"] ?? "https://sepolia-rollup.arbitrum.io/rpc",
    // Deployed 2026-06-23 — see contracts/deployments/sepolia.json
    storageContractAddress: "0xe497b4ba27dacaf92354bd34da253a0a88aa57d4",
  },
  prod: {
    rpcUrl: process.env["ARBITRUM_MAINNET_RPC"] ?? "",
    // TBD: update when the protocol is deployed to Arbitrum One mainnet
    storageContractAddress: "",
  },
};

/**
 * Returns the NetworkConfig for the current environment.
 *
 * Reads the ENV environment variable to select the network.
 * Throws if ENV is not set or is not "dev" or "prod".
 */
export function getNetworkConfig(): NetworkConfig {
  const env = process.env["ENV"];
  if (env === "dev" || env === "prod") {
    const config = NETWORK_CONFIGS[env];
    if (env === "prod" && !config.storageContractAddress) {
      throw new Error("Mainnet deployment is not yet configured. Set storageContractAddress in networkConfig.ts.");
    }
    return config;
  }
  throw new Error(
    `ENV must be "dev" or "prod", got: ${JSON.stringify(env ?? "(unset)")}`,
  );
}
