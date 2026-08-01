/**
 * Shared live-deployment setup for dev-tests suites: mints real,
 * on-chain-registered membership cards against the live dev press.
 *
 * Adapted from integration_tests/suites/support/liveCard.ts. The key
 * difference: that file's `ensureLiveGovernance` bootstraps a brand-new
 * policy on every process run via `contracts/deployments/local.json`'s
 * `dev_governance_keypair` -- a keypair with unrestricted governance
 * authority that only exists for the local devnode.
 * `contracts/deployments/sepolia.json` has no such keypair, and contract/
 * governance actions are deliberately excluded from automation (see
 * plans/deployment/strategic-plan.md Goal 3). This file therefore never
 * bootstraps anything: `DEV_TESTS_POLICY_ID`/`DEV_TESTS_POLICY_ADDRESS` must
 * already reference a real, pre-provisioned, out-of-band-governed policy
 * that the dev press is already authorized under -- see README.md's "Dev
 * governance prerequisite".
 */

import { mintCard, type MintedCard } from './mintCard.js';
import { deriveKeypair } from './keys.js';
import { keccak256 } from '@membership-card-protocol/app-sdk';

export const PRESS_BASE_URL = (process.env.DEV_PRESS_URL ?? '').replace(/\/$/, '');
export const WALLET_SERVICE_BASE_URL = (process.env.DEV_WALLET_SERVICE_URL ?? '').replace(/\/$/, '');
export const RELAY_BASE_URL = (process.env.DEV_RELAY_URL ?? '').replace(/\/$/, '');
export const ARBITRUM_RPC_URL = process.env.DEV_ARBITRUM_RPC_URL ?? '';
export const REGISTRY_CONTRACT_ADDRESS = process.env.DEV_REGISTRY_CONTRACT_ADDRESS ?? '';
// The Stylus logic/storage contract split (see contracts/deployments/*.json's
// `contracts.logic_contract` / `contracts.storage_contract`) needs a second
// address for anything that calls the logic contract directly (e.g.
// getProtocolVersion() — see conformance/ipfs_card.spec.ts). Not required by
// most suites, so kept separate from REGISTRY_CONTRACT_ADDRESS (which mirrors
// press/wallet-service's own env var, semantically the storage contract).
export const LOGIC_CONTRACT_ADDRESS = process.env.DEV_LOGIC_CONTRACT_ADDRESS ?? '';
export const IPFS_GATEWAY_URL = process.env.DEV_IPFS_GATEWAY_URL ?? 'https://ipfs.filebase.io';
// Bearer token for the dev press's operator-only /api/admin/* endpoints
// (see press/DEPLOYMENT.md) -- needed only by suites that exercise
// trusted-root registration / app-gas crediting (e.g.
// suites/extended/subcard_creation_policy.spec.ts). Never logged.
export const PRESS_ADMIN_API_KEY = process.env.DEV_PRESS_ADMIN_API_KEY ?? '';
// Ethereum wallet paying gas for the small number of dev-tests suites that
// submit raw governance contract writes themselves (RegisterDomain/
// DeregisterDomain/SetDnsGovernancePolicyAddress/RegisterPolicy) rather than
// going through press's HTTP API (which pays gas from its own wallet).
// Distinct from press/wallet-service's own gas wallets. See
// plans/deployment/dev-governance-rotation-runbook.md.
export const DEV_TESTS_GAS_WALLET_PRIVATE_KEY = process.env.DEV_TESTS_GAS_WALLET_PRIVATE_KEY ?? '';

export interface LiveGovernance {
  policyId: string;
  policyAddress: string;
}

/**
 * Returns the pre-provisioned dev policy's identifiers from config. Not a
 * bootstrap -- fails loudly if the operator hasn't set these up yet, rather
 * than silently trying to create a policy against real infra.
 */
export function ensureLiveGovernance(): LiveGovernance {
  const policyId = process.env.DEV_TESTS_POLICY_ID;
  const policyAddress = process.env.DEV_TESTS_POLICY_ADDRESS;
  if (!policyId || !policyAddress) {
    throw new Error(
      'ensureLiveGovernance: DEV_TESTS_POLICY_ID / DEV_TESTS_POLICY_ADDRESS are not set. ' +
        'dev-tests requires a policy already registered on-chain and a press already ' +
        'authorized under it via a real out-of-band governance action -- see README.md\'s ' +
        '"Dev governance prerequisite". This function never bootstraps one itself.',
    );
  }
  return { policyId, policyAddress };
}

let pressCardCidPromise: Promise<string> | undefined;

/**
 * Fetches the dev press's own `press_card_cid` (memoized per process) --
 * several suites need to reference the press's own card CID as an offer's
 * `press_card` field (see mintCard.ts's identical fetch and its doc comment
 * on why the value must match exactly).
 */
export function getPressCardCid(): Promise<string> {
  if (!pressCardCidPromise) {
    pressCardCidPromise = (async () => {
      const res = await fetch(`${PRESS_BASE_URL}/api/press`);
      if (!res.ok) {
        throw new Error(`getPressCardCid: GET /api/press failed: HTTP ${res.status}`);
      }
      const body = (await res.json()) as { press_card_cid?: string };
      if (!body.press_card_cid) {
        throw new Error('getPressCardCid: GET /api/press response did not include press_card_cid');
      }
      return body.press_card_cid;
    })();
  }
  return pressCardCidPromise;
}

export interface LiveIdentity {
  address: string;
  publicKey: Uint8Array;
  secretKey: Uint8Array;
  cardCid: string;
}

/**
 * Mints a fresh, real, on-chain-registered card against the live dev press
 * and returns its full signing identity (mintCard itself only returns the
 * public key -- the secret key is re-derived deterministically from the
 * same label, per mintCard.ts's own `holder:${label}` convention).
 */
export async function mintLiveCard(labelPrefix: string, fieldValues?: Record<string, unknown>): Promise<LiveIdentity> {
  const { policyId } = ensureLiveGovernance();
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
