/**
 * Registry write gate, step 8 (`specs/object_specs/registry_contract.md
 * §6.1`; error E-49 `PAYLOAD_CALLDATA_MISMATCH`), against the logic
 * contract deployed on the local nitro-devnode.
 *
 * Step 8: every operation-specific field of the signed payload must equal
 * the calldata. Before it, the gate checked only `op` and `sequence`, so
 * whoever relays a signed payload (a notary's host relays what its enclave
 * signs) could submit it with any card address or CID (ADR-013, D5).
 *
 * The suite uses its own policy and its own press key, authorized by the
 * dev governance keypair, and submits transactions directly, so it doesn't
 * depend on the press service. For each operation it checks that a valid
 * signature with altered calldata reverts with E-49, and that the same
 * signature with the signed calldata succeeds.
 *
 * Requires the `integration_tests` stack up and
 * `contracts/deployments/local.json` to exist.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { createPublicClient, createWalletClient, http, parseAbi, encodeFunctionData, keccak256 as viemKeccak, toHex, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { arbitrumSepolia } from 'viem/chains';
import { p256 } from '@noble/curves/p256';
import { keccak_256 } from '@noble/hashes/sha3';
import { base64UrlToBytes } from '@membership-card-protocol/app-sdk';
import { ensureGovernanceBootstrap, type GovernanceKeypair } from '@membership-card-protocol/integration-fixtures';
import { ARBITRUM_RPC_URL } from '../support/liveCard.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');

const LOGIC_ABI = parseAbi([
  'function registerCard(bytes32 card_address, uint8[] initial_log_cid, bytes32 policy_address, bytes32 press_address, uint8[] press_sig_payload, uint8[] press_signature) external',
  'function updateCardHead(bytes32 card_address, uint8[] new_log_cid, uint8[] prev_log_cid, bytes32 press_address, uint8[] press_sig_payload, uint8[] press_signature) external',
  'function batchUpdateCardHeads(bytes32 policy_address, bytes32 press_address, bytes32[] card_addresses, uint8[][] prev_log_cids, uint8[][] new_log_cids, uint8[] press_sig_payload, uint8[] press_signature) external',
]);
const STORAGE_ABI = parseAbi([
  'function getCardEntry(bytes32 card_address) external view returns ((uint8[] log_head_cid, bytes32 policy_address, bytes32 last_press_address, bytes32 forward_to, bool exists) r)',
  'function getPressAuthorization(bytes32 policy_address, bytes32 press_address) external view returns ((uint8[] press_public_key, bytes32 mldsa44_key_hash, uint8 key_scheme, bool active, uint64 next_sequence, uint64 authorized_at, uint64 revoked_at) r)',
]);

/** The 4-byte selector the logic contract reverts with for E-49. */
const E49 = viemKeccak(toHex('PayloadCalldataMismatch()')).slice(0, 10);

const enc = new TextEncoder();
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64url');
const b64h = (h: Hex) => b64(Buffer.from(h.slice(2), 'hex'));
const bytes32 = (): Hex => toHex(randomBytes(32));
const cid = (label: string) => enc.encode(`bafy-write-gate-${label}-${randomBytes(4).toString('hex')}`);

/** RFC 8785 for the flat payloads used here (sorted keys, no whitespace). */
function canonicalize(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalize).join(',')}]`;
  if (v !== null && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonicalize(o[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

function parseDevVars(path: string): Record<string, string> {
  return Object.fromEntries(
    readFileSync(path, 'utf-8')
      .split('\n')
      .filter((l) => l.includes('=') && !l.startsWith('#'))
      .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)])
  );
}

/** Finds revert data anywhere in a viem error chain. */
function revertSelector(err: unknown): string | undefined {
  let e: any = err;
  for (let i = 0; e && i < 10; i++, e = e.cause) {
    const d = typeof e.data === 'string' ? e.data : typeof e.data?.data === 'string' ? e.data.data : undefined;
    if (d && d.startsWith('0x') && d.length >= 10) return d.slice(0, 10).toLowerCase();
  }
  const m = String((err as Error)?.message ?? '').match(/0x[0-9a-fA-F]{8}/);
  return m?.[0].toLowerCase();
}

describe('registry write gate step 8 (E-49) on the devnode', () => {
  const publicClient = createPublicClient({ chain: arbitrumSepolia, transport: http(ARBITRUM_RPC_URL) });
  let walletClient: ReturnType<typeof createWalletClient>;
  let logic: Hex;
  let storage: Hex;
  const policy = bytes32();
  const press = bytes32();
  const pressKey = p256.utils.randomPrivateKey();

  async function nextSequence(): Promise<number> {
    const r = (await publicClient.readContract({ address: storage, abi: STORAGE_ABI, functionName: 'getPressAuthorization', args: [policy, press] })) as { next_sequence: bigint };
    return Number(r.next_sequence);
  }

  async function sign(op: string, fields: Record<string, unknown>) {
    const payload = enc.encode(canonicalize({ op, ...fields, press_address: b64h(press), sequence: await nextSequence(), timestamp: new Date().toISOString() }));
    const sig = p256.sign(keccak_256(payload), pressKey, { lowS: true, prehash: false }).toCompactRawBytes();
    return { payload: Array.from(payload), sig: Array.from(sig) };
  }

  /** eth_call the write; resolves to the revert selector, or undefined if it would succeed. */
  async function tryCall(functionName: 'registerCard' | 'updateCardHead' | 'batchUpdateCardHeads', args: readonly unknown[]) {
    try {
      await publicClient.call({ account: walletClient.account!, to: logic, data: encodeFunctionData({ abi: LOGIC_ABI, functionName, args: args as any }) });
      return undefined;
    } catch (err) {
      return revertSelector(err) ?? 'reverted (no data)';
    }
  }

  async function send(functionName: 'registerCard' | 'updateCardHead' | 'batchUpdateCardHeads', args: readonly unknown[]) {
    const hash = await walletClient.writeContract({ address: logic, abi: LOGIC_ABI, functionName, args: args as any, account: walletClient.account!, chain: arbitrumSepolia });
    const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 });
    expect(receipt.status).toBe('success');
  }

  async function head(card: Hex): Promise<string> {
    const e = (await publicClient.readContract({ address: storage, abi: STORAGE_ABI, functionName: 'getCardEntry', args: [card] })) as { log_head_cid: readonly number[] };
    return Buffer.from(e.log_head_cid).toString();
  }

  beforeAll(async () => {
    const deployment = JSON.parse(readFileSync(join(REPO_ROOT, 'contracts/deployments/local.json'), 'utf-8')) as {
      contracts: { logic_contract: Hex; storage_contract: Hex };
      dev_governance_keypair: GovernanceKeypair;
    };
    logic = deployment.contracts.logic_contract;
    storage = deployment.contracts.storage_contract;
    const vars = parseDevVars(join(REPO_ROOT, 'integration_tests/env/press/.dev.vars'));
    const gasKey = (vars.PRESS_GAS_WALLET_PRIVATE_KEY.startsWith('0x') ? vars.PRESS_GAS_WALLET_PRIVATE_KEY : `0x${vars.PRESS_GAS_WALLET_PRIVATE_KEY}`) as Hex;
    walletClient = createWalletClient({ account: privateKeyToAccount(gasKey), chain: arbitrumSepolia, transport: http(ARBITRUM_RPC_URL) });

    await ensureGovernanceBootstrap({
      rpcUrl: ARBITRUM_RPC_URL,
      logicAddress: logic,
      storageAddress: storage,
      policyAddress: policy,
      pressAddress: press,
      pressSecp256r1PrivateKey: Buffer.from(pressKey).toString('hex'),
      pressMlDsa44PrivateKey: base64UrlToBytes(vars.PRESS_MLDSA44_PRIVATE_KEY),
      governanceKeypair: deployment.dev_governance_keypair,
      pressGasWalletPrivateKey: gasKey,
      contractsScriptsDir: join(REPO_ROOT, 'contracts/scripts'),
    });
  }, 300_000);

  const cardA = bytes32();
  const cardB = bytes32();
  const genesisA = cid('genesis-a');
  const genesisB = cid('genesis-b');
  const nextA = cid('next-a');

  it('RegisterCard: a signature for one card cannot register another, or a different genesis CID', async () => {
    const { payload, sig } = await sign('register_card', { card_address: b64h(cardA), initial_log_cid: b64(genesisA), policy_address: b64h(policy) });
    const seq = await nextSequence();

    expect(await tryCall('registerCard', [cardB, Array.from(genesisA), policy, press, payload, sig])).toBe(E49);
    expect(await tryCall('registerCard', [cardA, Array.from(cid('junk')), policy, press, payload, sig])).toBe(E49);

    await send('registerCard', [cardA, Array.from(genesisA), policy, press, payload, sig]);
    expect(await head(cardA)).toBe(Buffer.from(genesisA).toString());
    expect(await nextSequence()).toBe(seq + 1);
  }, 120_000);

  it('RegisterCard: a payload carrying only op and sequence (accepted before step 8) is refused', async () => {
    const seq = await nextSequence();
    const payload = enc.encode(canonicalize({ op: 'register_card', sequence: seq, timestamp: new Date().toISOString() }));
    const sig = p256.sign(keccak_256(payload), pressKey, { lowS: true, prehash: false }).toCompactRawBytes();
    expect(await tryCall('registerCard', [cardB, Array.from(genesisB), policy, press, Array.from(payload), Array.from(sig)])).toBe(E49);
  }, 120_000);

  it('UpdateCardHead: a relayed signature cannot point the head at junk or roll it back', async () => {
    const { payload, sig } = await sign('update_card_head', { card_address: b64h(cardA), prev_log_cid: b64(genesisA), new_log_cid: b64(nextA) });

    // Junk head, same signature.
    expect(await tryCall('updateCardHead', [cardA, Array.from(cid('junk')), Array.from(genesisA), press, payload, sig])).toBe(E49);

    await send('updateCardHead', [cardA, Array.from(nextA), Array.from(genesisA), press, payload, sig]);
    expect(await head(cardA)).toBe(Buffer.from(nextA).toString());

    // Roll back: a fresh signature for next→genesis is honest; replaying the
    // old signature with swapped CIDs is not (its sequence is spent too, but
    // step 8 refuses it on content with a current sequence as well).
    const fresh = await sign('update_card_head', { card_address: b64h(cardA), prev_log_cid: b64(nextA), new_log_cid: b64(cid('honest')) });
    expect(await tryCall('updateCardHead', [cardA, Array.from(genesisA), Array.from(nextA), press, fresh.payload, fresh.sig])).toBe(E49);
  }, 120_000);

  it('BatchUpdateCardHeads: the calldata list must equal the signed list in length, order and content', async () => {
    {
      const { payload, sig } = await sign('register_card', { card_address: b64h(cardB), initial_log_cid: b64(genesisB), policy_address: b64h(policy) });
      await send('registerCard', [cardB, Array.from(genesisB), policy, press, payload, sig]);
    }
    const newA = cid('batch-a');
    const newB = cid('batch-b');
    const items = [
      { card: cardA, prev: nextA, next: newA },
      { card: cardB, prev: genesisB, next: newB },
    ];
    const { payload, sig } = await sign('batch_update_card_heads', {
      policy_address: b64h(policy),
      updates: items.map((u) => ({ card_address: b64h(u.card), prev_log_cid: b64(u.prev), new_log_cid: b64(u.next) })),
    });
    const args = (list: typeof items) => [policy, press, list.map((u) => u.card), list.map((u) => Array.from(u.prev)), list.map((u) => Array.from(u.next)), payload, sig] as const;

    expect(await tryCall('batchUpdateCardHeads', args([items[1], items[0]]))).toBe(E49); // reordered
    expect(await tryCall('batchUpdateCardHeads', args([items[0]]))).toBe(E49); // shorter
    expect(await tryCall('batchUpdateCardHeads', args([items[0], { ...items[1], next: cid('junk') }]))).toBe(E49); // one item changed

    await send('batchUpdateCardHeads', args(items));
    expect(await head(cardA)).toBe(Buffer.from(newA).toString());
    expect(await head(cardB)).toBe(Buffer.from(newB).toString());
  }, 180_000);
});
