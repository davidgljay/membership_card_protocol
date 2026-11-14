/**
 * Host configuration from environment variables (notary_host.md §4), validated once at startup.
 *
 * Additions the spec's table does not cover (recorded as erratum E18): `ENCLAVE_ENDPOINTS` (how to reach each
 * `ENCLAVE_CIDS` entry through the vsock proxy, or a socket in the simulator), `NOTARY_ADMIN_TOKEN` (the spec says
 * `/genesis*` is "operator-authenticated" without a mechanism; a shared bearer token follows the press's admin
 * routes), `NOTARY_RELAY_TARGET_ID` and `NOTARY_PUBLIC_BASE_URL` (announcement `transport` hints).
 */
import { b64uDecode } from "@membership-card-protocol/wallet-sdk/notary-types";

export interface EnclaveEndpoint { cid: string; address: { unix: string } | { host: string; port: number } }

export interface HostConfig {
  NOTARY_CARD_ADDRESSES: string[];
  /** K_host seed (ML-DSA-44), 32 bytes. Signs host receipts. */
  NOTARY_HOST_MLDSA44_SEED: Uint8Array;
  /** X25519 OHTTP gateway key, 32 bytes. */
  NOTARY_OHTTP_PRIVATE_KEY: Uint8Array;
  NOTARY_GAS_WALLET_PRIVATE_KEY: string;
  ARBITRUM_RPC_URL: string;
  EXPECTED_CHAIN_ID: number;
  REGISTRY_CONTRACT_ADDRESS: string;
  EAS_CONTRACT_ADDRESS: string;
  NOTARY_EAS_SCHEMA_UID: string;
  IPFS_PROVIDER: "mock" | "kubo" | "sim";
  /** `rpc` (Phase 7 clients) or `sim`: the simulated chain at `SIM_CHAIN_URL` (docker-compose.sim.yml only). */
  CHAIN_PROVIDER: "rpc" | "sim";
  SIM_CHAIN_URL: string | undefined;
  KUBO_API_URL: string | undefined;
  EXTERNAL_KV_URL: string;
  ENCLAVE_CIDS: string[];
  ENCLAVE_ENDPOINTS: EnclaveEndpoint[];
  PEER_HOSTS: string[];
  SNAPSHOT_REFRESH_SECONDS: number;
  REATTEST_INTERVAL_SECONDS: number;
  ALERT_WEBHOOK_URL: string | undefined;
  NOTARY_ADMIN_TOKEN: string;
  NOTARY_RELAY_TARGET_ID: string;
  NOTARY_PUBLIC_BASE_URL: string;
}

export class ConfigError extends Error {
  constructor(public readonly problems: string[]) { super(`Invalid host configuration:\n - ${problems.join("\n - ")}`); }
}

type Env = Record<string, string | undefined>;

export function loadConfig(env: Env): HostConfig {
  const problems: string[] = [];
  const req = (k: string): string => { const v = env[k]; if (!v) problems.push(`${k} is required`); return v ?? ""; };
  const list = (k: string, required = true): string[] => { const v = required ? req(k) : env[k] ?? ""; return v.split(",").map((s) => s.trim()).filter(Boolean); };
  const key32 = (k: string): Uint8Array => { const v = req(k); try { return b64uDecode(v, 32); } catch { if (v) problems.push(`${k} must be 32 bytes, base64url`); return new Uint8Array(32); } };
  const int = (k: string, dflt: number): number => {
    const v = env[k]; if (v === undefined || v === "") return dflt;
    const n = Number(v); if (!Number.isInteger(n) || n <= 0) { problems.push(`${k} must be a positive integer`); return dflt; } return n;
  };
  const cards = list("NOTARY_CARD_ADDRESSES", false);
  for (const c of cards) if (!/^[0-9a-f]{64}$/.test(c)) problems.push(`NOTARY_CARD_ADDRESSES: ${c} is not 64 lowercase hex characters`);
  const gas = req("NOTARY_GAS_WALLET_PRIVATE_KEY");
  if (gas && !/^(0x)?[0-9a-fA-F]{64}$/.test(gas)) problems.push("NOTARY_GAS_WALLET_PRIVATE_KEY must be 32 bytes of hex");
  const addr = (k: string): string => { const v = req(k); if (v && !/^0x[0-9a-fA-F]{40}$/.test(v)) problems.push(`${k} must be a 0x-prefixed 20-byte address`); return v; };
  const schema = req("NOTARY_EAS_SCHEMA_UID");
  if (schema && !/^0x[0-9a-fA-F]{64}$/.test(schema)) problems.push("NOTARY_EAS_SCHEMA_UID must be 0x plus 64 hex characters");
  const provider = env["IPFS_PROVIDER"] ?? "";
  if (provider !== "mock" && provider !== "kubo" && provider !== "sim") problems.push('IPFS_PROVIDER must be "mock", "kubo" or "sim"');
  const chainProvider = env["CHAIN_PROVIDER"] ?? "rpc";
  if (chainProvider !== "rpc" && chainProvider !== "sim") problems.push('CHAIN_PROVIDER must be "rpc" or "sim"');
  if ((chainProvider === "sim" || provider === "sim") && !env["SIM_CHAIN_URL"]) problems.push("SIM_CHAIN_URL is required with the simulated chain");
  if (provider === "sim" && chainProvider !== "sim") problems.push("IPFS_PROVIDER=sim requires CHAIN_PROVIDER=sim");
  if (provider === "kubo" && !env["KUBO_API_URL"]) problems.push("KUBO_API_URL is required when IPFS_PROVIDER=kubo");
  const cids = list("ENCLAVE_CIDS");
  const endpoints: EnclaveEndpoint[] = [];
  for (const e of list("ENCLAVE_ENDPOINTS", false)) {
    const m = /^([^=]+)=(?:unix:(.+)|([^:]+):(\d{1,5}))$/.exec(e);
    if (!m) { problems.push(`ENCLAVE_ENDPOINTS entry "${e}" must be cid=unix:/path or cid=host:port`); continue; }
    endpoints.push({ cid: m[1]!, address: m[2] ? { unix: m[2] } : { host: m[3]!, port: Number(m[4]) } });
  }
  for (const c of cids) if (!endpoints.some((e) => e.cid === c)) problems.push(`ENCLAVE_CIDS entry ${c} has no ENCLAVE_ENDPOINTS address`);
  const admin = req("NOTARY_ADMIN_TOKEN");
  if (admin && admin.length < 32) problems.push("NOTARY_ADMIN_TOKEN must be at least 32 characters");
  const cfg: HostConfig = {
    NOTARY_CARD_ADDRESSES: cards, NOTARY_HOST_MLDSA44_SEED: key32("NOTARY_HOST_MLDSA44_PRIVATE_KEY"), NOTARY_OHTTP_PRIVATE_KEY: key32("NOTARY_OHTTP_PRIVATE_KEY"),
    NOTARY_GAS_WALLET_PRIVATE_KEY: gas, ARBITRUM_RPC_URL: req("ARBITRUM_RPC_URL"), EXPECTED_CHAIN_ID: int("EXPECTED_CHAIN_ID", 42161),
    REGISTRY_CONTRACT_ADDRESS: addr("REGISTRY_CONTRACT_ADDRESS"), EAS_CONTRACT_ADDRESS: addr("EAS_CONTRACT_ADDRESS"), NOTARY_EAS_SCHEMA_UID: schema,
    IPFS_PROVIDER: provider === "kubo" ? "kubo" : provider === "sim" ? "sim" : "mock",
    CHAIN_PROVIDER: chainProvider === "sim" ? "sim" : "rpc", SIM_CHAIN_URL: env["SIM_CHAIN_URL"] || undefined, KUBO_API_URL: env["KUBO_API_URL"], EXTERNAL_KV_URL: req("EXTERNAL_KV_URL"),
    ENCLAVE_CIDS: cids, ENCLAVE_ENDPOINTS: endpoints, PEER_HOSTS: list("PEER_HOSTS", false), SNAPSHOT_REFRESH_SECONDS: int("SNAPSHOT_REFRESH_SECONDS", 30),
    REATTEST_INTERVAL_SECONDS: int("REATTEST_INTERVAL_SECONDS", 21_600), ALERT_WEBHOOK_URL: env["ALERT_WEBHOOK_URL"] || undefined,
    NOTARY_ADMIN_TOKEN: admin, NOTARY_RELAY_TARGET_ID: req("NOTARY_RELAY_TARGET_ID"), NOTARY_PUBLIC_BASE_URL: req("NOTARY_PUBLIC_BASE_URL"),
  };
  if (problems.length > 0) throw new ConfigError(problems);
  return cfg;
}
