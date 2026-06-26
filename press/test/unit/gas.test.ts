/**
 * Gas manager unit tests.
 *
 * All on-chain calls are mocked. Tests cover:
 * - P-20 error when press balance is insufficient
 * - checkAppGasBalance: sufficient / insufficient / sponsor paths
 * - creditAppGasAccount: balance is updated in KV
 * - debitAppGasAccount: balance is reduced (floors at 0)
 * - extractAppCardFromCalldata: 32-byte hex calldata is parsed correctly
 * - pollEthTransfers: qualifying ETH transfers credit the right account
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createGasManager } from '../../src/chain/gas.js';
import { createInMemoryKv, kvKeys } from '../../src/kv.js';
import type { PressConfig } from '../../src/config.js';
import type { RegistryClient } from '../../src/chain/registry.js';

// A real secp256r1 private key (hex, 32 bytes).
const SECP_PRIV = 'ab'.repeat(32);

const CONFIG = {
  PRESS_SECP256R1_PRIVATE_KEY: SECP_PRIV,
  ARBITRUM_RPC_URL: 'https://arb1.arbitrum.io/rpc',
  MAX_BATCH_SIZE: 100,
} as unknown as PressConfig;

// Derived press address for the test key.
import { privateKeyToAccount } from 'viem/accounts';
const PRESS_ADDR = privateKeyToAccount(`0x${SECP_PRIV}`).address.toLowerCase();

const APP_ADDR = '0x' + 'cc'.repeat(32); // 32-byte app card address (keccak256 of pubkey)

// Mock viem public client.
vi.mock('viem', async (importOriginal) => {
  const actual = await importOriginal<typeof import('viem')>();
  return {
    ...actual,
    createPublicClient: vi.fn(() => mockPublicClient),
  };
});

const mockPublicClient = {
  getGasPrice: vi.fn().mockResolvedValue(1_000_000_000n), // 1 gwei
  getBlockNumber: vi.fn().mockResolvedValue(1000n),
  getBlock: vi.fn(),
};

function makeRegistry(balanceWei: bigint): RegistryClient {
  return {
    getPressEthBalance: vi.fn().mockResolvedValue(balanceWei),
  } as unknown as RegistryClient;
}

describe('checkGasBalance', () => {
  it('does not throw when balance is sufficient', async () => {
    const kv = createInMemoryKv();
    // RegisterCard estimate: 200_000 gas × 1 gwei = 2×10^14 wei. Use 1 ETH (10^18).
    const mgr = createGasManager(CONFIG, makeRegistry(1_000_000_000_000_000_000n), kv);
    await expect(mgr.checkGasBalance('RegisterCard')).resolves.toBeUndefined();
  });

  it('throws P-20 when balance is below the raw estimate', async () => {
    const kv = createInMemoryKv();
    // Estimate for RegisterCard = 200_000 gas × 1 gwei = 200_000_000_000 wei
    const mgr = createGasManager(CONFIG, makeRegistry(1n), kv);
    await expect(mgr.checkGasBalance('RegisterCard')).rejects.toMatchObject({
      pressCode: 'P-20',
    });
  });
});

describe('checkAppGasBalance', () => {
  it('returns { sufficient: true } when balance covers the estimate', async () => {
    const kv = createInMemoryKv();
    await kv.setItem(kvKeys.appGas(APP_ADDR), {
      balance_wei: '1000000000000000', // 0.001 ETH — well above estimate
      last_funded_at: null,
      last_debited_at: null,
    });
    const mgr = createGasManager(CONFIG, makeRegistry(0n), kv);
    const result = await mgr.checkAppGasBalance(APP_ADDR, 'RegisterSubCard');
    expect(result).toEqual({ sufficient: true });
  });

  it('returns { sufficient: false } for RegisterSubCard with zero balance', async () => {
    const kv = createInMemoryKv();
    const mgr = createGasManager(CONFIG, makeRegistry(0n), kv);
    const result = await mgr.checkAppGasBalance(APP_ADDR, 'RegisterSubCard');
    expect(result.sufficient).toBe(false);
    expect(result.sponsor).toBeUndefined();
  });

  it('returns { sufficient: false, sponsor: true } for DeregisterSubCard with zero balance', async () => {
    const kv = createInMemoryKv();
    const mgr = createGasManager(CONFIG, makeRegistry(0n), kv);
    const result = await mgr.checkAppGasBalance(APP_ADDR, 'DeregisterSubCard');
    expect(result).toEqual({ sufficient: false, sponsor: true });
  });

  it('returns { sufficient: true } for DeregisterSubCard when balance is non-zero', async () => {
    const kv = createInMemoryKv();
    await kv.setItem(kvKeys.appGas(APP_ADDR), {
      balance_wei: '1000000000000000',
      last_funded_at: null,
      last_debited_at: null,
    });
    const mgr = createGasManager(CONFIG, makeRegistry(0n), kv);
    const result = await mgr.checkAppGasBalance(APP_ADDR, 'DeregisterSubCard');
    expect(result.sufficient).toBe(true);
  });
});

describe('creditAppGasAccount', () => {
  it('creates the record when the account does not exist', async () => {
    const kv = createInMemoryKv();
    const mgr = createGasManager(CONFIG, makeRegistry(0n), kv);
    await mgr.creditAppGasAccount(APP_ADDR, 500_000_000_000n);
    const record = await kv.getItem<{ balance_wei: string }>(kvKeys.appGas(APP_ADDR));
    expect(record?.balance_wei).toBe('500000000000');
  });

  it('accumulates on an existing balance', async () => {
    const kv = createInMemoryKv();
    await kv.setItem(kvKeys.appGas(APP_ADDR), {
      balance_wei: '1000',
      last_funded_at: null,
      last_debited_at: null,
    });
    const mgr = createGasManager(CONFIG, makeRegistry(0n), kv);
    await mgr.creditAppGasAccount(APP_ADDR, 500n);
    const record = await kv.getItem<{ balance_wei: string }>(kvKeys.appGas(APP_ADDR));
    expect(record?.balance_wei).toBe('1500');
  });
});

describe('debitAppGasAccount', () => {
  it('reduces the balance by the spent amount', async () => {
    const kv = createInMemoryKv();
    await kv.setItem(kvKeys.appGas(APP_ADDR), {
      balance_wei: '1000',
      last_funded_at: null,
      last_debited_at: null,
    });
    const mgr = createGasManager(CONFIG, makeRegistry(0n), kv);
    await mgr.debitAppGasAccount(APP_ADDR, 300n);
    const record = await kv.getItem<{ balance_wei: string }>(kvKeys.appGas(APP_ADDR));
    expect(record?.balance_wei).toBe('700');
  });

  it('floors at zero when spend exceeds balance', async () => {
    const kv = createInMemoryKv();
    await kv.setItem(kvKeys.appGas(APP_ADDR), {
      balance_wei: '100',
      last_funded_at: null,
      last_debited_at: null,
    });
    const mgr = createGasManager(CONFIG, makeRegistry(0n), kv);
    await mgr.debitAppGasAccount(APP_ADDR, 999n);
    const record = await kv.getItem<{ balance_wei: string }>(kvKeys.appGas(APP_ADDR));
    expect(record?.balance_wei).toBe('0');
  });
});

describe('pollEthTransfers', () => {
  beforeEach(() => {
    mockPublicClient.getBlockNumber.mockResolvedValue(1000n);
    mockPublicClient.getBlock.mockClear();
  });

  it('credits an app account when a qualifying ETH transfer is found', async () => {
    const kv = createInMemoryKv();
    const appHex = 'cc'.repeat(32); // 64 hex chars

    mockPublicClient.getBlock.mockResolvedValue({
      transactions: [
        {
          to: PRESS_ADDR,
          value: 1_000_000n,
          input: `0x${appHex}`,
          hash: '0xabc',
        },
      ],
    });

    const mgr = createGasManager(CONFIG, makeRegistry(0n), kv);
    await mgr.pollEthTransfers(1000n);

    const record = await kv.getItem<{ balance_wei: string }>(
      kvKeys.appGas(`0x${appHex}`)
    );
    expect(record?.balance_wei).toBe('1000000');
  });

  it('ignores transactions sent to a different address', async () => {
    const kv = createInMemoryKv();
    const appHex = 'cc'.repeat(32);

    mockPublicClient.getBlock.mockResolvedValue({
      transactions: [
        {
          to: '0xdeadbeef00000000000000000000000000000000',
          value: 1_000_000n,
          input: `0x${appHex}`,
          hash: '0xdef',
        },
      ],
    });

    const mgr = createGasManager(CONFIG, makeRegistry(0n), kv);
    await mgr.pollEthTransfers(1000n);

    const record = await kv.getItem<{ balance_wei: string }>(
      kvKeys.appGas(`0x${appHex}`)
    );
    expect(record).toBeNull();
  });

  it('ignores transactions with zero value', async () => {
    const kv = createInMemoryKv();
    const appHex = 'cc'.repeat(32);

    mockPublicClient.getBlock.mockResolvedValue({
      transactions: [
        { to: PRESS_ADDR, value: 0n, input: `0x${appHex}`, hash: '0xghi' },
      ],
    });

    const mgr = createGasManager(CONFIG, makeRegistry(0n), kv);
    await mgr.pollEthTransfers(1000n);

    const record = await kv.getItem<{ balance_wei: string }>(
      kvKeys.appGas(`0x${appHex}`)
    );
    expect(record).toBeNull();
  });

  it('ignores transactions with calldata that is not a 32-byte hex string', async () => {
    const kv = createInMemoryKv();

    mockPublicClient.getBlock.mockResolvedValue({
      transactions: [
        { to: PRESS_ADDR, value: 1_000n, input: '0xdeadbeef', hash: '0xjkl' },
      ],
    });

    const mgr = createGasManager(CONFIG, makeRegistry(0n), kv);
    await mgr.pollEthTransfers(1000n);

    // No accounts should be credited
    const keys = [kvKeys.appGas('0xdeadbeef')];
    for (const k of keys) {
      expect(await kv.getItem(k)).toBeNull();
    }
  });

  it('returns fromBlock when fromBlock > latest', async () => {
    const kv = createInMemoryKv();
    mockPublicClient.getBlockNumber.mockResolvedValue(500n);
    const mgr = createGasManager(CONFIG, makeRegistry(0n), kv);
    const result = await mgr.pollEthTransfers(1000n);
    expect(result).toBe(500n);
    expect(mockPublicClient.getBlock).not.toHaveBeenCalled();
  });
});
