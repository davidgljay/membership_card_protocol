/**
 * Read-only Arbitrum One registry client — resolves a sub-card's
 * `SubCardEntry` (specifically `sub_card_doc_cid`) so the wallet service can
 * fetch the sub-card's `SubCardDocument` from IPFS and recover its
 * `recipient_pubkey` (notification_relay.md v0.8 §POST
 * /cards/{card_hash}/subcards/{subcard_hash}/uuids, specs/subcards.md §Step
 * 5). The wallet service never writes to this contract — only `press/`
 * does (see press/src/chain/registry.ts, which this mirrors for the single
 * read operation this service needs).
 *
 * Deliberately not shared as a workspace dependency with press/: the
 * wallet service only needs one read function, not press's write/retry
 * machinery, and the two services have independent config/deploy
 * lifecycles.
 */

import { createPublicClient, http, parseAbi, type Hex, type PublicClient } from 'viem';
import { arbitrum } from 'viem/chains';
import type { WalletServiceConfig } from '../config.js';

// Read-only subset of the registry ABI this service needs
// (press/src/chain/registry.ts REGISTRY_ABI has the full set).
const REGISTRY_ABI = parseAbi([
  'function GetSubCardEntry(bytes32 sub_card_address) external view returns (bytes32 master_card_address, bytes registration_log_head, bytes sub_card_doc_cid, bool active, uint64 registered_at, uint64 deregistered_at)',
]);

export interface SubCardEntry {
  master_card_address: Hex;
  registration_log_head: Uint8Array;
  sub_card_doc_cid: Uint8Array;
  active: boolean;
  registered_at: bigint;
  deregistered_at: bigint;
}

export interface SubcardRegistryClient {
  getSubCardEntry(subCardAddress: Hex): Promise<SubCardEntry>;
}

let cachedClient: SubcardRegistryClient | null = null;

/** Returns the process-wide singleton, constructing it from config on first use. Mirrors db/client.ts's getPool() caching pattern. */
export function getSubcardRegistryClient(config: WalletServiceConfig): SubcardRegistryClient {
  if (!cachedClient) {
    cachedClient = createSubcardRegistryClient(config);
  }
  return cachedClient;
}

/** Test-only: clears the cached client so tests can inject a fresh mock/config. */
export function resetSubcardRegistryClientCache(): void {
  cachedClient = null;
}

export function createSubcardRegistryClient(config: WalletServiceConfig): SubcardRegistryClient {
  const publicClient: PublicClient = createPublicClient({
    chain: arbitrum,
    transport: http(config.ARBITRUM_RPC_URL),
  });
  const contractAddress = config.REGISTRY_CONTRACT_ADDRESS as Hex;

  return {
    async getSubCardEntry(subCardAddress: Hex): Promise<SubCardEntry> {
      const result = await publicClient.readContract({
        address: contractAddress,
        abi: REGISTRY_ABI,
        functionName: 'GetSubCardEntry',
        args: [subCardAddress],
      });
      const [master_card_address, registration_log_head, sub_card_doc_cid, active, registered_at, deregistered_at] =
        result as unknown as [Hex, Uint8Array, Uint8Array, boolean, bigint, bigint];
      return {
        master_card_address,
        registration_log_head: new Uint8Array(registration_log_head),
        sub_card_doc_cid: new Uint8Array(sub_card_doc_cid),
        active,
        registered_at,
        deregistered_at,
      };
    },
  };
}
