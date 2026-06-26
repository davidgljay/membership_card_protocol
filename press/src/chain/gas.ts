/**
 * Gas management for the press.
 *
 * Two concerns:
 *
 * 1. Press ETH balance (checkGasBalance)
 *    Before every on-chain write the press confirms it has enough ETH to cover
 *    the estimated gas cost with a 20% buffer. Rejects with P-20 if insufficient.
 *
 * 2. App gas accounts (checkAppGasBalance, creditAppGasAccount, pollEthTransfers)
 *    Apps pre-fund sub-card operations by sending ETH to the press's Arbitrum
 *    address with their app_card_address (keccak256 of ML-DSA-44 pubkey,
 *    hex-encoded as a 64-char hex string) in the transaction calldata.
 *    Balances are stored in the KV store under press:app_gas:<address>.
 *
 *    Transfer monitoring uses eth_getLogs-style block iteration (polling),
 *    suitable for stateless Nitro serverless invocations. A scheduled Nitro
 *    task drives the polling; see server/tasks/poll-eth-transfers.ts (Phase 4).
 */

import { createPublicClient, http, type PublicClient, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { arbitrum } from 'viem/chains';
import type { PressConfig } from '../config.js';
import type { RegistryClient } from './registry.js';
import { kvKeys, type KvStore, type AppGasRecord } from '../kv.js';

// ---------------------------------------------------------------------------
// Static gas estimates (gas units) per operation.
// Refined at CP-3 once real contract measurements are available.
// ---------------------------------------------------------------------------

const GAS_ESTIMATES: Record<string, bigint> = {
  RegisterCard: 200_000n,
  UpdateCardHead: 80_000n,
  ClaimOpenOffer: 220_000n,
  RegisterSubCard: 150_000n,
  DeregisterSubCard: 100_000n,
  BatchUpdateCardHeads: 500_000n,
};

const BUFFER_FACTOR = 1.2; // 20% safety buffer

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GasCheckResult {
  sufficient: boolean;
  sponsor?: boolean;
}

export interface GasManager {
  /**
   * Confirm the press's own ETH balance covers the estimated gas for `operation`.
   * Logs a warning when balance drops below the 20% buffer.
   * Throws a P-20 tagged error if balance is below the raw estimate.
   */
  checkGasBalance(operation: string): Promise<void>;

  /**
   * Check an app card's pre-funded gas account balance against the estimated
   * cost of `operation`.
   *
   * RegisterSubCard: returns { sufficient: false } when balance < estimate.
   * DeregisterSubCard: returns { sufficient: false, sponsor: true } when
   *   balance is zero so the press self-sponsors the gas (spec §5.4).
   */
  checkAppGasBalance(appCardAddress: string, operation: string): Promise<GasCheckResult>;

  /** Credit an app gas account (called after a confirmed ETH transfer is detected). */
  creditAppGasAccount(appCardAddress: string, weiAmount: bigint): Promise<void>;

  /** Debit an app gas account after a successful sub-card write. */
  debitAppGasAccount(appCardAddress: string, weiSpent: bigint): Promise<void>;

  /**
   * Scan blocks [fromBlock, latest] for ETH transfers to the press address
   * whose calldata encodes a 32-byte app_card_address.
   * Credits any qualifying app gas accounts.
   * Returns the latest block number processed (caller should checkpoint this).
   */
  pollEthTransfers(fromBlock: bigint): Promise<bigint>;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createGasManager(
  config: PressConfig,
  registry: RegistryClient,
  kv: KvStore
): GasManager {
  const publicClient: PublicClient = createPublicClient({
    chain: arbitrum,
    transport: http(config.ARBITRUM_RPC_URL),
  });

  const pressAddress: string = privateKeyToAccount(
    (config.PRESS_SECP256R1_PRIVATE_KEY.startsWith('0x')
      ? config.PRESS_SECP256R1_PRIVATE_KEY
      : `0x${config.PRESS_SECP256R1_PRIVATE_KEY}`) as Hex
  ).address;

  async function estimatedCostWei(operation: string): Promise<bigint> {
    const gasUnits = GAS_ESTIMATES[operation] ?? 200_000n;
    const gasPrice = await publicClient.getGasPrice();
    return gasUnits * gasPrice;
  }

  async function checkGasBalance(operation: string): Promise<void> {
    const balance = await registry.getPressEthBalance();
    const cost = await estimatedCostWei(operation);
    const buffered = BigInt(Math.ceil(Number(cost) * BUFFER_FACTOR));

    if (balance < cost) {
      throw Object.assign(
        new Error(
          `P-20: Insufficient ETH balance for ${operation}. ` +
            `Have ${balance} wei, need ~${cost} wei.`
        ),
        { pressCode: 'P-20' }
      );
    }
    if (balance < buffered) {
      console.warn(
        `[press] Low ETH balance for ${operation}: ${balance} wei ` +
          `(below 20% buffer; recharge to at least ${buffered} wei)`
      );
    }
  }

  async function checkAppGasBalance(
    appCardAddress: string,
    operation: string
  ): Promise<GasCheckResult> {
    const record = await kv.getItem<AppGasRecord>(kvKeys.appGas(appCardAddress));
    const balance = record ? BigInt(record.balance_wei) : 0n;

    if (operation === 'DeregisterSubCard' && balance === 0n) {
      return { sufficient: false, sponsor: true };
    }

    const cost = await estimatedCostWei(operation);
    return { sufficient: balance >= cost };
  }

  async function creditAppGasAccount(appCardAddress: string, weiAmount: bigint): Promise<void> {
    const key = kvKeys.appGas(appCardAddress);
    const existing = await kv.getItem<AppGasRecord>(key);
    const current = existing ? BigInt(existing.balance_wei) : 0n;
    await kv.setItem<AppGasRecord>(key, {
      balance_wei: (current + weiAmount).toString(),
      last_funded_at: Math.floor(Date.now() / 1000),
      last_debited_at: existing?.last_debited_at ?? null,
    });
  }

  async function debitAppGasAccount(appCardAddress: string, weiSpent: bigint): Promise<void> {
    const key = kvKeys.appGas(appCardAddress);
    const existing = await kv.getItem<AppGasRecord>(key);
    const current = existing ? BigInt(existing.balance_wei) : 0n;
    const next = current > weiSpent ? current - weiSpent : 0n;
    await kv.setItem<AppGasRecord>(key, {
      balance_wei: next.toString(),
      last_funded_at: existing?.last_funded_at ?? null,
      last_debited_at: Math.floor(Date.now() / 1000),
    });
  }

  async function pollEthTransfers(fromBlock: bigint): Promise<bigint> {
    const latestBlock = await publicClient.getBlockNumber();
    if (fromBlock > latestBlock) return latestBlock;

    // Scan in batches to avoid timing out on large ranges.
    const BATCH = 100n;
    let cursor = fromBlock;

    while (cursor <= latestBlock) {
      const to = cursor + BATCH - 1n < latestBlock ? cursor + BATCH - 1n : latestBlock;

      for (let n = cursor; n <= to; n++) {
        try {
          const block = await publicClient.getBlock({
            blockNumber: n,
            includeTransactions: true,
          });

          for (const tx of block.transactions) {
            if (typeof tx === 'string') continue;
            if (tx.to?.toLowerCase() !== pressAddress.toLowerCase()) continue;
            if (!tx.value || tx.value === 0n) continue;

            const appAddr = extractAppCardFromCalldata(tx.input);
            if (!appAddr) continue;

            await creditAppGasAccount(appAddr, tx.value);
            console.info(
              `[press] App gas credited: ${tx.value} wei → ${appAddr} (tx ${tx.hash}, block ${n})`
            );
          }
        } catch (err) {
          console.warn(`[press] ETH transfer poll: error at block ${n}: ${String(err)}`);
        }
      }

      cursor = to + 1n;
    }

    return latestBlock;
  }

  return {
    checkGasBalance,
    checkAppGasBalance,
    creditAppGasAccount,
    debitAppGasAccount,
    pollEthTransfers,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract an app_card_address from transaction calldata.
 * The spec requires callers to encode their keccak256(ML-DSA-44 pubkey)
 * as exactly 32 bytes (64 hex chars, with or without 0x prefix) in calldata.
 */
function extractAppCardFromCalldata(calldata: Hex): string | null {
  const raw = calldata.startsWith('0x') ? calldata.slice(2) : calldata;
  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    return `0x${raw.toLowerCase()}`;
  }
  return null;
}
