/**
 * Shared live-stack setup for `suites/core/` (and beyond): mints real,
 * on-chain-registered membership cards against the local nitro-devnode
 * stack, doing the governance bootstrap + policy pinning exactly once per
 * process (module-level memoization) rather than once per test file.
 *
 * This exists so individual process-spec suites don't each re-derive
 * `harnesses/web/src/prepare.ts`'s governance/policy setup — the shared
 * pieces (local.json + press .dev.vars reading, `ensureGovernanceBootstrap`,
 * the permissive test policy) are lifted out here; suite-specific identity
 * setup (which cards to mint, for what role) stays in each spec file.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import {
  buildPermissiveTestPolicy,
  pinJsonToKubo,
  mintCard,
  deriveKeypair,
  ensureGovernanceBootstrap,
  type GovernanceKeypair,
  type MintedCard,
} from '@membership-card-protocol/integration-fixtures';
import { keccak256, base64UrlToBytes } from '@membership-card-protocol/app-sdk';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');

export const PRESS_BASE_URL = (process.env.SUITE_PRESS_URL ?? 'http://localhost:3001').replace(/\/$/, '');
export const KUBO_API_URL = process.env.SUITE_KUBO_API_URL ?? 'http://localhost:5001';
export const ARBITRUM_RPC_URL = process.env.SUITE_ARBITRUM_RPC_URL ?? 'http://localhost:8547';

function parseDevVars(path: string): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const line of readFileSync(path, 'utf-8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    vars[trimmed.slice(0, eq)] = trimmed.slice(eq + 1);
  }
  return vars;
}

export interface LiveGovernance {
  policyId: string;
  policyAddress: string;
  pressCardCid: string;
  pressAddress: string;
}

let governancePromise: Promise<LiveGovernance> | undefined;

/**
 * Idempotent, memoized within this process: bootstraps chain governance
 * for the shared permissive test policy (no-op if already governed — see
 * `ensureGovernanceBootstrap`'s own doc comment) and returns the policy/
 * press identifiers every `mintLiveCard` call needs. Safe to call from
 * multiple test files/suites; each only pays the bootstrap cost once.
 */
export function ensureLiveGovernance(): Promise<LiveGovernance> {
  if (!governancePromise) {
    governancePromise = (async () => {
      const pressInfo = (await (await fetch(`${PRESS_BASE_URL}/api/press`)).json()) as {
        press_card_cid: string;
        gas_address: string;
      };
      const policy = buildPermissiveTestPolicy(pressInfo.press_card_cid);
      const policyId = await pinJsonToKubo(KUBO_API_URL, policy);
      const policyAddress = '0x' + keccak256(new TextEncoder().encode(policyId));

      const deploymentFile = join(REPO_ROOT, 'contracts/deployments/local.json');
      const deployment = JSON.parse(readFileSync(deploymentFile, 'utf-8')) as {
        contracts: { logic_contract: string; storage_contract: string };
        dev_governance_keypair: GovernanceKeypair;
      };
      const pressDevVars = parseDevVars(join(REPO_ROOT, 'integration_tests/env/press/.dev.vars'));

      await ensureGovernanceBootstrap({
        rpcUrl: ARBITRUM_RPC_URL,
        logicAddress: deployment.contracts.logic_contract as `0x${string}`,
        storageAddress: deployment.contracts.storage_contract as `0x${string}`,
        policyAddress,
        pressAddress: pressInfo.gas_address as `0x${string}`,
        pressSecp256r1PrivateKey: pressDevVars.PRESS_SECP256R1_PRIVATE_KEY!,
        pressMlDsa44PrivateKey: base64UrlToBytes(pressDevVars.PRESS_MLDSA44_PRIVATE_KEY!),
        governanceKeypair: deployment.dev_governance_keypair,
        pressGasWalletPrivateKey: pressDevVars.PRESS_GAS_WALLET_PRIVATE_KEY!,
        contractsScriptsDir: join(REPO_ROOT, 'contracts/scripts'),
      });

      return {
        policyId,
        policyAddress,
        pressCardCid: pressInfo.press_card_cid,
        pressAddress: pressInfo.gas_address,
      };
    })();
  }
  return governancePromise;
}

export interface LiveIdentity {
  address: string;
  publicKey: Uint8Array;
  secretKey: Uint8Array;
  cardCid: string;
}

/**
 * Mints a fresh, real, on-chain-registered card and returns its full
 * signing identity (mintCard itself only returns the public key — the
 * secret key is re-derived deterministically from the same label, per
 * `mintCard.ts`'s own `holder:${label}` convention).
 */
export async function mintLiveCard(labelPrefix: string, fieldValues?: Record<string, unknown>): Promise<LiveIdentity> {
  const { policyId } = await ensureLiveGovernance();
  const label = `${labelPrefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const minted: MintedCard = await mintCard({
    pressBaseUrl: PRESS_BASE_URL,
    policyId,
    label,
    fieldValues,
  });
  const keypair = deriveKeypair(`holder:${label}`);
  return {
    address: keccak256(keypair.publicKey),
    publicKey: keypair.publicKey,
    secretKey: keypair.secretKey,
    cardCid: minted.cardCid,
  };
}
