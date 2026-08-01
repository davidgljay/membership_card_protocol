/**
 * Narrower-scoped governance helpers for the two dev-tests-owned governance
 * bodies (Body 0 -- RootPolicyBody, Body 2 -- DnsGovernanceBody), rotated
 * away from the shared bootstrap key per
 * plans/deployment/dev-governance-rotation-runbook.md. dev-tests holds all
 * 3 keys for each body's 2-of-3 quorum itself (this is a dev/test-only
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
 * Never call `ensureGovernanceBootstrap`-style logic here -- these helpers
 * only rotate/exercise the two bodies dev-tests was explicitly granted
 * narrower authority over; they must not be extended to Body 1
 * (PressRegistryBody), which stays under whatever authorizes the dev press.
 */

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { createPublicClient, createWalletClient, http, parseAbi, type Hex, type Abi } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { arbitrumSepolia } from 'viem/chains';
import { ARBITRUM_RPC_URL, LOGIC_CONTRACT_ADDRESS, DEV_TESTS_GAS_WALLET_PRIVATE_KEY } from './liveCard.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const CONTRACTS_SCRIPTS_DIR = join(REPO_ROOT, 'contracts/scripts');

export type GovernanceBody = 'policy' | 'dns';

function bodyId(body: GovernanceBody): number {
  return body === 'policy' ? 0 : 2;
}

function bodyKeyEnvPrefix(body: GovernanceBody): string {
  return body === 'policy' ? 'DEV_TESTS_POLICY_GOV_PRIVKEY_' : 'DEV_TESTS_DNS_GOV_PRIVKEY_';
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
