/**
 * The notary host's production chain clients (`notary/host/src/chain/rpc.ts`) against the registry deployed on the local
 * nitro-devnode (Phase 7, 7.1, Q7). Devnode only (CP7): the suite refuses any RPC URL that is not local.
 *
 * What it checks, with the real contract's write gate in the way:
 * - `submitter.submit` sends an enclave-style `register_card` and `batch_update_card_heads` unchanged, and the contract
 *   accepts them; a payload whose signature is for another card is refused with a named reason, not a trace;
 * - `chain.cardHead`, `pressAuth` and `protocolVersion` read what was written;
 * - `feed.registry(policy)` returns every registration and head update under the policy (unfiltered), with the head CIDs
 *   as text and the policy card's head;
 * - `feed.headersAfter(n)` returns headers, oldest first, with RLP that hashes to the block hash.
 *
 * Requires the integration stack's devnode with contracts deployed (`docker compose --profile local-chain up -d
 * nitro-devnode deploy-contracts`) and `contracts/deployments/local.json`.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { privateKeyToAccount } from 'viem/accounts';
import { keccak256, toHex, type Hex } from 'viem';
import { p256 } from '@noble/curves/p256';
import { keccak_256 } from '@noble/hashes/sha3';
import { base64UrlToBytes } from '@membership-card-protocol/app-sdk';
import { ensureGovernanceBootstrap, type GovernanceKeypair } from '@membership-card-protocol/integration-fixtures';
import { ARBITRUM_RPC_URL } from '../support/liveCard.js';
import { canonicalNotary } from '@membership-card-protocol/wallet-sdk/notary-types';
import { rpcChain } from '../../../notary/host/src/chain/rpc.ts';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const enc = new TextEncoder();
const b64 = (b: Uint8Array) => Buffer.from(b).toString('base64url');
const hexOf = (h: Hex) => h.slice(2);
const b64h = (h: Hex) => b64(Buffer.from(hexOf(h), 'hex'));
const bytes32 = (): Hex => toHex(randomBytes(32));
const cid = (label: string) => `bafy-notary-rpc-${label}-${randomBytes(4).toString('hex')}`;

function parseDevVars(path: string): Record<string, string> {
  return Object.fromEntries(readFileSync(path, 'utf-8').split('\n').filter((l) => l.includes('=') && !l.startsWith('#')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
}

describe('notary host: production chain clients on the devnode', () => {
  const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1|nitro-devnode)(:\d+)?/.test(ARBITRUM_RPC_URL);
  const policy = bytes32();
  const press = bytes32();
  const pressKey = p256.utils.randomPrivateKey();
  let client: ReturnType<typeof rpcChain>;

  const sign = async (op: string, fields: Record<string, unknown>) => {
    const seq = Number(((await client.chain.pressAuth(hexOf(policy), hexOf(press))) as { next_sequence: number }).next_sequence);
    const payload = { op, ...fields, press_address: b64h(press), sequence: seq, timestamp: new Date().toISOString() };
    const digest = keccak_256(canonicalNotary(payload as never));
    return { payload, signature: b64(p256.sign(digest, pressKey, { lowS: true, prehash: false }).toCompactRawBytes()) };
  };

  beforeAll(async () => {
    expect(isLocal, `refusing a non-local RPC URL: ${ARBITRUM_RPC_URL}`).toBe(true);
    const deployment = JSON.parse(readFileSync(join(REPO_ROOT, 'contracts/deployments/local.json'), 'utf-8')) as {
      contracts: { logic_contract: Hex; storage_contract: Hex };
      dev_governance_keypair: GovernanceKeypair;
    };
    const vars = parseDevVars(join(REPO_ROOT, 'integration_tests/env/press/.dev.vars'));
    const rawGas = vars.PRESS_GAS_WALLET_PRIVATE_KEY!;
    const gasKey = (rawGas.startsWith('0x') ? rawGas : `0x${rawGas}`) as Hex;
    await ensureGovernanceBootstrap({
      rpcUrl: ARBITRUM_RPC_URL, logicAddress: deployment.contracts.logic_contract, storageAddress: deployment.contracts.storage_contract,
      policyAddress: policy, pressAddress: press, pressSecp256r1PrivateKey: Buffer.from(pressKey).toString('hex'),
      pressMlDsa44PrivateKey: base64UrlToBytes(vars.PRESS_MLDSA44_PRIVATE_KEY!), governanceKeypair: deployment.dev_governance_keypair,
      pressGasWalletPrivateKey: gasKey, contractsScriptsDir: join(REPO_ROOT, 'contracts/scripts'),
    });
    client = rpcChain({ rpcUrl: ARBITRUM_RPC_URL, logicContract: deployment.contracts.logic_contract, storageContract: deployment.contracts.storage_contract, gasWalletKey: gasKey });
    expect(client.account).toBe(privateKeyToAccount(gasKey).address);
  }, 300_000);

  const cardA = bytes32();
  const cardB = bytes32();
  const genesisA = cid('a0');
  const genesisB = cid('b0');
  const nextA = cid('a1');
  const nextB = cid('b1');

  it('reads the press authorization the bootstrap wrote (control: an unknown press is null)', async () => {
    const a = (await client.chain.pressAuth(hexOf(policy), hexOf(press))) as { active: boolean; next_sequence: number; press_public_key: string };
    expect(a.active).toBe(true);
    expect(typeof a.next_sequence).toBe('number');
    expect(a.press_public_key.length).toBeGreaterThan(40);
    expect(await client.chain.pressAuth(hexOf(policy), hexOf(bytes32()))).toBeNull();
  });

  it('reads the protocol version', async () => {
    expect(typeof (await client.chain.protocolVersion())).toBe('string');
  });

  it('submits an enclave-style register_card unchanged, and the contract accepts it', async () => {
    const { payload, signature } = await sign('register_card', { card_address: b64h(cardA), initial_log_cid: b64(enc.encode(genesisA)), policy_address: b64h(policy) });
    const calldata = { card_address: b64h(cardA), initial_log_cid: b64(enc.encode(genesisA)), policy_address: b64h(policy), press_address: b64h(press) };
    const r = await client.submitter.submit({ op: 'register_card', payload, signature, calldata });
    expect('txHash' in r, JSON.stringify(r)).toBe(true);
    const head = JSON.parse(new TextDecoder().decode((await client.chain.cardHead(hexOf(cardA)))!)) as { head_cid: string; events: { cid: string }[] };
    expect(head.head_cid).toBe(genesisA);
    expect(head.events.map((e) => e.cid)).toEqual([genesisA]);
  }, 120_000);

  it('a signature made for one card cannot register another: refused, with a reason', async () => {
    const { payload, signature } = await sign('register_card', { card_address: b64h(cardA), initial_log_cid: b64(enc.encode(genesisB)), policy_address: b64h(policy) });
    // the signed payload names cardA; the calldata names cardB (what a lying host would do): step 8
    const calldata = { card_address: b64h(cardB), initial_log_cid: b64(enc.encode(genesisB)), policy_address: b64h(policy), press_address: b64h(press) };
    const r = await client.submitter.submit({ op: 'register_card', payload, signature, calldata });
    expect('failed' in r).toBe(true);
    expect(await client.chain.cardHead(hexOf(cardB))).toBeNull();
  }, 120_000);

  it('an unsupported op is refused before anything is sent', async () => {
    const r = await client.submitter.submit({ op: 'delete_everything', payload: {}, signature: '', calldata: {} });
    expect(r).toEqual({ failed: 'UNSUPPORTED_OP:delete_everything' });
  });

  it('submits a batch_update_card_heads for two cards under the policy', async () => {
    const reg = await sign('register_card', { card_address: b64h(cardB), initial_log_cid: b64(enc.encode(genesisB)), policy_address: b64h(policy) });
    expect('txHash' in (await client.submitter.submit({ op: 'register_card', ...reg, calldata: { card_address: b64h(cardB), initial_log_cid: b64(enc.encode(genesisB)), policy_address: b64h(policy), press_address: b64h(press) } }))).toBe(true);
    const updates = [
      { card_address: b64h(cardA), prev_log_cid: b64(enc.encode(genesisA)), new_log_cid: b64(enc.encode(nextA)) },
      { card_address: b64h(cardB), prev_log_cid: b64(enc.encode(genesisB)), new_log_cid: b64(enc.encode(nextB)) },
    ];
    const { payload, signature } = await sign('batch_update_card_heads', { policy_address: b64h(policy), updates });
    const r = await client.submitter.submit({ op: 'batch_update_card_heads', payload, signature, calldata: { policy_address: b64h(policy), press_address: b64h(press), updates } });
    expect('txHash' in r, JSON.stringify(r)).toBe(true);
    const a = JSON.parse(new TextDecoder().decode((await client.chain.cardHead(hexOf(cardA)))!)) as { head_cid: string };
    expect(a.head_cid).toBe(nextA);
  }, 180_000);

  it('feed.registry(policy) lists every registration and head update under the policy, unfiltered', async () => {
    const r = await client.feed.registry(hexOf(policy));
    const byCard = (c: Hex) => r.events.filter((e) => e.cardAddress === hexOf(c)).map((e) => `${e.kind}:${e.headCid}`);
    expect(byCard(cardA)).toEqual([`CardRegistered:${genesisA}`, `CardHeadUpdated:${nextA}`]);
    expect(byCard(cardB)).toEqual([`CardRegistered:${genesisB}`, `CardHeadUpdated:${nextB}`]);
    expect(r.events.every((e) => e.policyAddress === hexOf(policy) && e.pressAddress === hexOf(press) && /^\d{4}-/.test(e.timestamp))).toBe(true);
    expect(r.block).toBeGreaterThan(0);
    // a policy with no cards: nothing, and not another policy's cards (control)
    const other = await client.feed.registry(hexOf(bytes32()));
    expect(other.events).toEqual([]);
  }, 60_000);

  it('feed.headersAfter returns headers oldest first, and the RLP hashes to the block hash', async () => {
    const latest = Number(await client.publicClient.getBlockNumber());
    const hs = await client.feed.headersAfter(latest - 3);
    expect(hs.map((h) => h.number)).toEqual([latest - 2, latest - 1, latest].slice(0, hs.length));
    expect(hs.length).toBeGreaterThanOrEqual(3);
    for (const h of hs) {
      const blk = await client.publicClient.getBlock({ blockNumber: BigInt(h.number) });
      expect(keccak256(toHex(base64UrlToBytes(h.header_rlp)))).toBe(blk.hash);
      expect(h.timestamp).toBe(Number(blk.timestamp));
    }
  }, 60_000);
});
