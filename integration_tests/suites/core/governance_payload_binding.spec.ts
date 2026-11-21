/**
 * Governance payload binding (`specs/object_specs/registry_contract.md §6.2`
 * step 0, E-49 `PAYLOAD_CALLDATA_MISMATCH`), the signed open-offer limits
 * (§4.5, 6.4a W4) and the DNS path rule (§4.19/§4.23, 6.4a W6), against the
 * logic contract deployed on the local nitro-devnode (notary step 6.4b).
 *
 * Before step 0, a quorum-signed governance payload could be submitted once
 * with any calldata, for any operation of the same body. Each case here
 * signs a payload for one call and checks that changed calldata, or another
 * operation's payload, reverts with E-49, and that the signed call itself
 * goes through.
 *
 * Calls that would change state other suites rely on (rotating a keyset,
 * proposing a logic upgrade) are only simulated with eth_call. On the devnode
 * the dev governance keypair is the 1-of-1 keyset of all three bodies.
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
import { ensureGovernanceBootstrap, ensureDnsGovernancePolicy, registerDomain, type GovernanceKeypair } from '@membership-card-protocol/integration-fixtures';
import { ARBITRUM_RPC_URL } from '../support/liveCard.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');

const LOGIC_ABI = parseAbi([
  'function registerCard(bytes32 card_address, uint8[] initial_log_cid, bytes32 policy_address, bytes32 press_address, uint8[] press_sig_payload, uint8[] press_signature) external',
  'function claimOpenOffer(bytes32 offer_id, uint64 max_acceptances, uint64 expires_at, bytes32 card_address, uint8[] initial_log_cid, bytes32 policy_address, bytes32 press_address, uint8[] press_sig_payload, uint8[] press_signature) external',
  'function authorizePress(bytes32 policy_address, bytes32 press_address, uint8[] press_pubkey, bytes32 mldsa44_key_hash, uint8[] governance_payload, uint8[][] governance_sigs) external',
  'function revokePress(bytes32 policy_address, bytes32 press_address, uint8[] governance_payload, uint8[][] governance_sigs) external',
  'function rotateGovernanceKeys(uint8 body_id, uint8[] new_keys_flat, uint8 new_key_count, uint8 new_quorum, uint8[] governance_payload, uint8[][] governance_sigs) external',
  'function proposeLogicUpgrade(address new_logic_address, uint8[] governance_payload, uint8[][] governance_sigs) external',
  'function governanceSetPolicyAddress(uint8[] domain, uint8[] path, bytes32 policy_card_address, uint8[] governance_payload, uint8[][] governance_sigs) external',
  'function lookupPolicyAddress(uint8[] domain, uint8[] path) external view returns (bytes32)',
]);
const STORAGE_ABI = parseAbi([
  'function getGovernanceKeyset(uint8 body_id) external view returns ((uint8[] keys, uint8 key_count, uint8 quorum, uint32 version, uint8 key_scheme) r)',
  'function getPressAuthorization(bytes32 policy_address, bytes32 press_address) external view returns ((uint8[] press_public_key, bytes32 mldsa44_key_hash, uint8 key_scheme, bool active, uint64 next_sequence, uint64 authorized_at, uint64 revoked_at) r)',
]);
type Fn = Exclude<(typeof LOGIC_ABI)[number]['name'], 'lookupPolicyAddress'>;

const sel = (sig: string) => viemKeccak(toHex(sig)).slice(0, 10);
const E49 = sel('PayloadCalldataMismatch()');
const E43 = sel('InvalidDnsParameter()');
const ROOT = 0, PRESS_REGISTRY = 1, DNS = 2;

const enc = new TextEncoder();
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64url');
const b64h = (h: Hex) => b64(Buffer.from(h.slice(2), 'hex'));
const bytes32 = (): Hex => toHex(randomBytes(32));
const cid = (label: string) => enc.encode(`bafy-gov-binding-${label}-${randomBytes(4).toString('hex')}`);
const utf8 = (s: string) => Array.from(enc.encode(s));
const ZERO32 = `0x${'00'.repeat(32)}` as Hex;

/** RFC 8785 for the payloads used here (sorted keys, no whitespace). */
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

function revertSelector(err: unknown): string | undefined {
  let e: any = err;
  for (let i = 0; e && i < 10; i++, e = e.cause) {
    const d = typeof e.data === 'string' ? e.data : typeof e.data?.data === 'string' ? e.data.data : undefined;
    if (d && d.startsWith('0x') && d.length >= 10) return d.slice(0, 10).toLowerCase();
  }
  const m = String((err as Error)?.message ?? '').match(/0x[0-9a-fA-F]{8}/);
  return m?.[0].toLowerCase();
}

describe('governance payload binding (§6.2 step 0), W4 limits and the W6 path rule on the devnode', () => {
  const publicClient = createPublicClient({ chain: arbitrumSepolia, transport: http(ARBITRUM_RPC_URL) });
  let walletClient: ReturnType<typeof createWalletClient>;
  let logic: Hex;
  let storage: Hex;
  let govKey: Uint8Array;
  let govKeypair: GovernanceKeypair;
  const policy = bytes32();
  const press = bytes32();
  const pressKey = p256.utils.randomPrivateKey();

  /** A governance payload for `body`, signed by the dev governance key (quorum 1). */
  async function gov(body: number, op: string, fields: Record<string, unknown>) {
    const r = (await publicClient.readContract({ address: storage, abi: STORAGE_ABI, functionName: 'getGovernanceKeyset', args: [body] })) as { version: number };
    const payload = enc.encode(canonicalize({ op, ...fields, governance_version: r.version, nonce: b64(randomBytes(32)), timestamp: new Date().toISOString() }));
    const sig = p256.sign(keccak_256(payload), govKey, { lowS: true, prehash: false }).toCompactRawBytes();
    return { payload: Array.from(payload), sigs: [Array.from(sig)] };
  }

  async function nextSequence(): Promise<number> {
    const r = (await publicClient.readContract({ address: storage, abi: STORAGE_ABI, functionName: 'getPressAuthorization', args: [policy, press] })) as { next_sequence: bigint };
    return Number(r.next_sequence);
  }

  async function pressSign(op: string, fields: Record<string, unknown>) {
    const payload = enc.encode(canonicalize({ op, ...fields, press_address: b64h(press), sequence: await nextSequence(), timestamp: new Date().toISOString() }));
    const sig = p256.sign(keccak_256(payload), pressKey, { lowS: true, prehash: false }).toCompactRawBytes();
    return { payload: Array.from(payload), sig: Array.from(sig) };
  }

  async function tryCall(functionName: Fn, args: readonly unknown[]) {
    try {
      await publicClient.call({ account: walletClient.account!, to: logic, data: encodeFunctionData({ abi: LOGIC_ABI, functionName, args: args as any }) });
      return undefined;
    } catch (err) {
      return revertSelector(err) ?? 'reverted (no data)';
    }
  }

  async function send(functionName: Fn, args: readonly unknown[]) {
    const hash = await walletClient.writeContract({ address: logic, abi: LOGIC_ABI, functionName, args: args as any, account: walletClient.account!, chain: arbitrumSepolia });
    const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 });
    expect(receipt.status).toBe('success');
  }

  async function registerCard(card: Hex, label: string) {
    const genesis = cid(label);
    const { payload, sig } = await pressSign('register_card', { card_address: b64h(card), initial_log_cid: b64(genesis), policy_address: b64h(policy) });
    await send('registerCard', [card, Array.from(genesis), policy, press, payload, sig]);
  }

  beforeAll(async () => {
    const deployment = JSON.parse(readFileSync(join(REPO_ROOT, 'contracts/deployments/local.json'), 'utf-8')) as {
      contracts: { logic_contract: Hex; storage_contract: Hex };
      dev_governance_keypair: GovernanceKeypair;
    };
    logic = deployment.contracts.logic_contract;
    storage = deployment.contracts.storage_contract;
    govKeypair = deployment.dev_governance_keypair;
    govKey = Buffer.from(govKeypair.private_key.replace(/^0x/, ''), 'hex');
    const vars = parseDevVars(join(REPO_ROOT, 'integration_tests/env/press/.dev.vars'));
    const rawGas = vars.PRESS_GAS_WALLET_PRIVATE_KEY!;
    const gasKey = (rawGas.startsWith('0x') ? rawGas : `0x${rawGas}`) as Hex;
    walletClient = createWalletClient({ account: privateKeyToAccount(gasKey), chain: arbitrumSepolia, transport: http(ARBITRUM_RPC_URL) });

    // The bootstrap itself now goes through step 0: RegisterPolicy and AuthorizePress
    // with payloads that carry every action field.
    await ensureGovernanceBootstrap({
      rpcUrl: ARBITRUM_RPC_URL,
      logicAddress: logic,
      storageAddress: storage,
      policyAddress: policy,
      pressAddress: press,
      pressSecp256r1PrivateKey: Buffer.from(pressKey).toString('hex'),
      pressMlDsa44PrivateKey: base64UrlToBytes(vars.PRESS_MLDSA44_PRIVATE_KEY!),
      governanceKeypair: govKeypair,
      pressGasWalletPrivateKey: gasKey,
      contractsScriptsDir: join(REPO_ROOT, 'contracts/scripts'),
    });
  }, 300_000);

  it('AuthorizePress: a quorum payload for one press cannot authorize another, change its key, or serve another operation', async () => {
    const otherPress = bytes32();
    const key = p256.getPublicKey(p256.utils.randomPrivateKey(), false).slice(1);
    const rogueKey = p256.getPublicKey(p256.utils.randomPrivateKey(), false).slice(1);
    const hash = bytes32();
    const fields = { policy_address: b64h(policy), press_address: b64h(otherPress), press_pubkey: b64(key), mldsa44_key_hash: b64h(hash) };
    const { payload, sigs } = await gov(PRESS_REGISTRY, 'authorize_press', fields);

    expect(await tryCall('authorizePress', [policy, bytes32(), Array.from(key), hash, payload, sigs])).toBe(E49); // another press
    expect(await tryCall('authorizePress', [policy, otherPress, Array.from(rogueKey), hash, payload, sigs])).toBe(E49); // the attacker's key
    expect(await tryCall('authorizePress', [policy, otherPress, Array.from(key), bytes32(), payload, sigs])).toBe(E49); // another ML-DSA hash

    // A RevokePress payload naming the same press is not an AuthorizePress payload, nor the reverse.
    const revoke = await gov(PRESS_REGISTRY, 'revoke_press', { policy_address: b64h(policy), press_address: b64h(otherPress) });
    expect(await tryCall('authorizePress', [policy, otherPress, Array.from(key), hash, revoke.payload, revoke.sigs])).toBe(E49);

    // The pre-6.4b payload shape (op, version and nonce only) is refused.
    const bare = await gov(PRESS_REGISTRY, 'authorize_press', {});
    expect(await tryCall('authorizePress', [policy, otherPress, Array.from(key), hash, bare.payload, bare.sigs])).toBe(E49);

    await send('authorizePress', [policy, otherPress, Array.from(key), hash, payload, sigs]);
    expect(await tryCall('revokePress', [policy, otherPress, payload, sigs])).toBe(E49);
    await send('revokePress', [policy, otherPress, revoke.payload, revoke.sigs]);
  }, 180_000);

  it('RotateGovernanceKeys: the signed keys, quorum and body are the only ones accepted (simulated)', async () => {
    const keys = [0, 1, 2].map(() => p256.getPublicKey(p256.utils.randomPrivateKey(), false).slice(1));
    const flat = Array.from(Buffer.concat(keys));
    const { payload, sigs } = await gov(DNS, 'rotate_governance_keys', { body_id: DNS, new_keys: keys.map(b64), new_quorum: 2 });

    const swapped = Array.from(Buffer.concat([keys[0]!, keys[1]!, p256.getPublicKey(p256.utils.randomPrivateKey(), false).slice(1)]));
    expect(await tryCall('rotateGovernanceKeys', [DNS, swapped, 3, 2, payload, sigs])).toBe(E49); // an attacker's key in
    expect(await tryCall('rotateGovernanceKeys', [DNS, flat, 3, 3, payload, sigs])).toBe(E49); // another quorum
    expect(await tryCall('rotateGovernanceKeys', [ROOT, flat, 3, 2, payload, sigs])).toBe(E49); // another body
    expect(await tryCall('rotateGovernanceKeys', [DNS, flat, 3, 2, payload, sigs])).toBeUndefined(); // the signed call would succeed
  }, 120_000);

  it('ProposeLogicUpgrade: a signed proposal cannot be redirected to another contract (simulated)', async () => {
    const target = toHex(randomBytes(20));
    const { payload, sigs } = await gov(ROOT, 'propose_logic_upgrade', { new_logic_address: b64h(target) });
    expect(await tryCall('proposeLogicUpgrade', [toHex(randomBytes(20)), payload, sigs])).toBe(E49);
    expect(await tryCall('proposeLogicUpgrade', [target, payload, sigs])).toBeUndefined();
  }, 120_000);

  it('ClaimOpenOffer (W4): the signed limits bind the calldata; null stands only for "no limit"', async () => {
    const UINT64_MAX = 18446744073709551615n;
    const claim = async (limits: { max: number | null; exp: number | null }) => {
      const card = bytes32();
      const offer = bytes32();
      const genesis = cid('claim');
      const { payload, sig } = await pressSign('claim_open_offer', {
        offer_id: b64h(offer), card_address: b64h(card), initial_log_cid: b64(genesis), policy_address: b64h(policy),
        max_acceptances: limits.max, expires_at: limits.exp,
      });
      return (max: bigint, exp: bigint) => [offer, max, exp, card, Array.from(genesis), policy, press, payload, sig] as const;
    };
    const later = BigInt(Math.floor(Date.now() / 1000) + 86_400);

    const limited = await claim({ max: 5, exp: Number(later) });
    expect(await tryCall('claimOpenOffer', limited(UINT64_MAX, 0n))).toBe(E49); // the W4 attack: lift both limits
    expect(await tryCall('claimOpenOffer', limited(6n, later))).toBe(E49);
    expect(await tryCall('claimOpenOffer', limited(5n, later + 1n))).toBe(E49);
    await send('claimOpenOffer', limited(5n, later));

    const open = await claim({ max: null, exp: null });
    expect(await tryCall('claimOpenOffer', open(5n, 0n))).toBe(E49); // null is not a number
    await send('claimOpenOffer', open(UINT64_MAX, 0n));
  }, 180_000);

  it('DNS (W6 and step 0): a path with a JSON-escaped character is refused on set, not on clearing; the path is bound', async () => {
    // A domain to write under: an admin card issued under this suite's policy, made the DNS
    // governance policy (other suites set their own the same way before RegisterDomain).
    const admin = bytes32();
    await registerCard(admin, 'dns-admin');
    const dns = { rpcUrl: ARBITRUM_RPC_URL, logicAddress: logic, storageAddress: storage, governanceKeypair: govKeypair, contractsScriptsDir: join(REPO_ROOT, 'contracts/scripts') };
    await ensureDnsGovernancePolicy({ ...dns, policyAddress: policy });
    const domain = `gov-binding-${randomBytes(4).toString('hex')}.test`;
    await registerDomain({ ...dns, domain, adminCardAddress: admin });

    const set = async (path: string, value: Hex) => {
      const { payload, sigs } = await gov(DNS, 'governance_set_policy_address', { domain, path, policy_card_address: b64h(value) });
      return [utf8(domain), utf8(path), value, payload, sigs] as const;
    };

    // The path rule: a quote, a backslash or a control character, on a non-clearing write.
    // (Such a path can't be written into a payload without an escape, so this payload is
    // signed with the escape; the rule refuses it first, with E-43.)
    for (const bad of ['/a"b', '/a\\b', '/a\nb']) {
      expect(await tryCall('governanceSetPolicyAddress', await set(bad, admin))).toBe(E43);
    }
    // Clearing doesn't apply the rule. Step 0 still compares the path byte for byte, and an
    // escaped path never equals the calldata, so such a clear is refused with E-49: an entry
    // with such a path must be removed before the upgrade (6.4b item 7, the pre-upgrade scan).
    expect(await tryCall('governanceSetPolicyAddress', await set('/a"b', ZERO32))).toBe(E49);
    expect(await tryCall('governanceSetPolicyAddress', await set('/never-set', ZERO32))).toBeUndefined();

    // Step 0: the signed path and value are the only ones accepted.
    const good = await set('/members', admin);
    expect(await tryCall('governanceSetPolicyAddress', [good[0], utf8('/other'), good[2], good[3], good[4]])).toBe(E49);
    // Another existing card (a random address would fail E-41, card not found, before step 0).
    const other = bytes32();
    await registerCard(other, 'dns-other');
    expect(await tryCall('governanceSetPolicyAddress', [good[0], good[1], other, good[3], good[4]])).toBe(E49);
    await send('governanceSetPolicyAddress', good);
    expect(await publicClient.readContract({ address: logic, abi: LOGIC_ABI, functionName: 'lookupPolicyAddress', args: [utf8(domain), utf8('/members')] })).toBe(admin);
  }, 300_000);
});
