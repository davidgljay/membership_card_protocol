/**
 * Narrower-scoped governance helpers for the three dev-tests-owned
 * governance bodies (Body 0 -- RootPolicyBody, Body 1 -- PressRegistryBody,
 * Body 2 -- DnsGovernanceBody), rotated away from the shared bootstrap key
 * per plans/deployment/dev-governance-rotation-runbook.md. dev-tests holds
 * all 3 keys for each body's 2-of-3 quorum itself (this is a dev/test-only
 * environment -- no cross-party coordination needed at test-run time), so
 * these helpers can assemble a full quorum signature locally.
 *
 * Payload construction and signing shell out to the same tested Rust
 * binaries `mintCard.ts`'s sibling fixtures always have
 * (`contracts/scripts/build_governance_payload.rs` / `sign_payload.rs`)
 * rather than hand-rolling a second, independently-risky canonicalization/
 * signing path -- same principle the original
 * integration_tests/suites/extended/dns_governance_verifier.spec.ts
 * followed.
 *
 * Body 1 was rotated later than Body 0/2 (this dev deployment's main use
 * case turned out to be dev-tests itself, so the narrower-credential scope
 * was widened -- see plans/deployment/phase-3-summary.md's "pending
 * decision" note and its resolution). Rotating it means dev-tests, not the
 * original deployer key, now controls AuthorizePress for this deployment
 * going forward.
 */

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { createPublicClient, createWalletClient, http, parseAbi, keccak256, type Hex, type Abi } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { arbitrumSepolia } from 'viem/chains';
import { ARBITRUM_RPC_URL, LOGIC_CONTRACT_ADDRESS, REGISTRY_CONTRACT_ADDRESS, DEV_TESTS_GAS_WALLET_PRIVATE_KEY } from './liveCard.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const CONTRACTS_SCRIPTS_DIR = join(REPO_ROOT, 'contracts/scripts');

export type GovernanceBody = 'policy' | 'press' | 'dns';

const BODY_IDS: Record<GovernanceBody, number> = { policy: 0, press: 1, dns: 2 };

function bodyId(body: GovernanceBody): number {
  return BODY_IDS[body];
}

const BODY_KEY_ENV_PREFIXES: Record<GovernanceBody, string> = {
  policy: 'DEV_TESTS_POLICY_GOV_PRIVKEY_',
  press: 'DEV_TESTS_PRESS_GOV_PRIVKEY_',
  dns: 'DEV_TESTS_DNS_GOV_PRIVKEY_',
};

function bodyKeyEnvPrefix(body: GovernanceBody): string {
  return BODY_KEY_ENV_PREFIXES[body];
}

function bodyKeys(body: GovernanceBody): string[] {
  const prefix = bodyKeyEnvPrefix(body);
  const keys = [1, 2, 3]
    .map((n) => process.env[`${prefix}${n}`])
    .filter((k): k is string => Boolean(k));
  if (keys.length < 2) {
    throw new Error(
      `governance.ts: need at least 2 of 3 ${prefix}* env vars set (quorum=2) -- ` +
        'see plans/deployment/dev-governance-rotation-runbook.md. This body has not ' +
        'been rotated to dev-tests-owned keys yet.',
    );
  }
  return keys;
}

/** Build a canonical governance-payload JSON string via the tested Rust binary. */
export function buildGovernancePayload(args: string[]): string {
  return execFileSync(
    'cargo',
    ['run', '--manifest-path', `${CONTRACTS_SCRIPTS_DIR}/Cargo.toml`, '--bin', 'build_governance_payload', '--quiet', '--', ...args],
    { encoding: 'utf-8' },
  ).trim();
}

function signPayloadWithKey(privateKeyHex: string, payload: string): string {
  return execFileSync(
    'cargo',
    ['run', '--manifest-path', `${CONTRACTS_SCRIPTS_DIR}/Cargo.toml`, '--bin', 'sign_payload', '--quiet', '--', '--key-hex', privateKeyHex, '--payload', payload],
    { encoding: 'utf-8' },
  ).trim();
}

/**
 * Signs a governance payload with a 2-of-3 quorum from dev-tests' own held
 * keys for the given body. Returns the signatures in the order the
 * contract expects (governance_sigs: Vec<Vec<u8>>).
 */
export function signGovernancePayloadQuorum(body: GovernanceBody, payload: string): string[] {
  const keys = bodyKeys(body).slice(0, 2); // quorum = 2
  return keys.map((k) => signPayloadWithKey(k, payload));
}

const GOV_KEYSET_ABI = parseAbi([
  'struct GovKeyset { uint8[] keys; uint8 key_count; uint8 quorum; uint32 version; uint8 key_scheme; }',
  'function getGovernanceKeyset(uint8 body_id) external view returns (GovKeyset r)',
]);

/** Reads the current governance_version for a body -- required for every payload build. */
export async function getGovernanceVersion(body: GovernanceBody): Promise<number> {
  const client = createPublicClient({ transport: http(ARBITRUM_RPC_URL) });
  const r = await client.readContract({
    address: LOGIC_CONTRACT_ADDRESS as Hex,
    abi: GOV_KEYSET_ABI,
    functionName: 'getGovernanceKeyset',
    args: [bodyId(body)],
  });
  return r.version;
}

/**
 * Convenience: builds a payload for `op` against the given body's current
 * version, signs it with dev-tests' own 2-of-3 quorum, and returns both the
 * payload string and its signatures -- ready to pass directly as the
 * `governance_payload`/`governance_sigs` contract arguments.
 */
export async function buildAndSignGovernanceOp(
  body: GovernanceBody,
  opArgs: string[],
): Promise<{ payload: string; signatures: string[] }> {
  const version = await getGovernanceVersion(body);
  const payload = buildGovernancePayload(['--version', String(version), ...opArgs]);
  const signatures = signGovernancePayloadQuorum(body, payload);
  return { payload, signatures };
}

/** Converts a UTF-8 payload string to the `uint8[]` argument shape the contract expects. */
export function payloadToUint8Array(payload: string): number[] {
  return Array.from(new TextEncoder().encode(payload));
}

/** Converts a `0x`-hex signature string to the `uint8[]` argument shape the contract expects. */
export function sigToUint8Array(sigHex: string): number[] {
  const clean = sigHex.startsWith('0x') ? sigHex.slice(2) : sigHex;
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return Array.from(bytes);
}

/**
 * Submits a governance-gated write directly to the logic contract, paying
 * gas from `DEV_TESTS_GAS_WALLET_PRIVATE_KEY` -- for the small number of
 * dev-tests suites (DNS governance, policy registration) that must submit
 * raw contract writes themselves rather than going through press's HTTP API
 * (which pays gas from its own wallet for the writes it fronts).
 */
export async function submitGovernanceTx(
  functionName: string,
  abi: Abi,
  args: readonly unknown[],
): Promise<Hex> {
  if (!DEV_TESTS_GAS_WALLET_PRIVATE_KEY) {
    throw new Error(
      'governance.ts: DEV_TESTS_GAS_WALLET_PRIVATE_KEY is not set -- see ' +
        'plans/deployment/dev-governance-rotation-runbook.md.',
    );
  }
  const account = privateKeyToAccount(DEV_TESTS_GAS_WALLET_PRIVATE_KEY as Hex);
  const walletClient = createWalletClient({ account, chain: arbitrumSepolia, transport: http(ARBITRUM_RPC_URL) });
  const publicClient = createPublicClient({ chain: arbitrumSepolia, transport: http(ARBITRUM_RPC_URL) });

  const hash = await walletClient.writeContract({
    address: LOGIC_CONTRACT_ADDRESS as Hex,
    abi,
    functionName,
    args,
    account,
    chain: arbitrumSepolia,
  });
  await publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 });
  return hash;
}

const AUTHORIZE_PRESS_ABI = parseAbi([
  'function authorizePress(bytes32 policy_address, bytes32 press_address, uint8[] press_pubkey, bytes32 mldsa_hash, uint8[] governance_payload, uint8[][] governance_sigs) external',
]);
const IS_PRESS_ACTIVE_ABI = parseAbi([
  'function isPressActive(bytes32 policy_address, bytes32 press_address) external view returns (bool)',
]);

/**
 * Authorizes the shared dev press under a freshly-registered policy, using
 * dev-tests' own Body 1 (PressRegistryBody) quorum -- the missing piece
 * that previously left log_auditing.spec.ts blocked (see
 * plans/deployment/phase-3-summary.md). The press's own public keys are
 * public values (safe in a committed .env.example placeholder-only, real
 * values still gitignored) -- only its *private* keys must stay out of any
 * agent session or repo file. No-ops if this (policy, press) pair is
 * already active.
 */
export async function authorizeDevPressUnderPolicy(policyAddress: Hex): Promise<void> {
  const pressPubkey = process.env['DEV_TESTS_PRESS_SECP256R1_PUBLIC_KEY'];
  const mldsaPubkey = process.env['DEV_TESTS_PRESS_MLDSA44_PUBLIC_KEY'];
  if (!pressPubkey || !mldsaPubkey) {
    throw new Error(
      'authorizeDevPressUnderPolicy: DEV_TESTS_PRESS_SECP256R1_PUBLIC_KEY / ' +
        'DEV_TESTS_PRESS_MLDSA44_PUBLIC_KEY are not set -- see dev-tests/.env.example. ' +
        'These are the dev press\'s public keys (from press/scripts/gen-press-keys.mjs), ' +
        'safe to record, distinct from its private keys.',
    );
  }

  const client = createPublicClient({ transport: http(ARBITRUM_RPC_URL) });
  const pressAddress = keccak256(pressPubkey as Hex);

  // isPressActive is a storage-contract read -- cast/viem calls to the
  // logic contract's cross-contract storage reads revert under a
  // STATICCALL (see contract_helpers.sh's note); REGISTRY_CONTRACT_ADDRESS
  // is dev-tests' name for the storage contract (see liveCard.ts).
  const alreadyActive = await client.readContract({
    address: REGISTRY_CONTRACT_ADDRESS as Hex,
    abi: IS_PRESS_ACTIVE_ABI,
    functionName: 'isPressActive',
    args: [policyAddress, pressAddress],
  });
  if (alreadyActive) return;

  const mldsaHash = keccak256(mldsaPubkey as Hex);
  const { payload, signatures } = await buildAndSignGovernanceOp('press', [
    '--op', 'authorize_press',
    '--policy', policyAddress,
    '--press', pressAddress,
    '--press-pubkey', pressPubkey,
  ]);

  await submitGovernanceTx('authorizePress', AUTHORIZE_PRESS_ABI, [
    policyAddress,
    pressAddress,
    sigToUint8Array(pressPubkey),
    mldsaHash,
    payloadToUint8Array(payload),
    signatures.map(sigToUint8Array),
  ]);
}
