/**
 * Registers a brand-new policy on-chain and authorizes the shared dev press
 * under it, entirely through dev-tests' own governance quorum (Body 0 +
 * Body 1) -- for suites that need a *fresh* policy per test case (distinct
 * field_definitions, auditors, etc.) rather than the shared
 * pre-provisioned one. Used by log_auditing.spec.ts, and could extend
 * policy_creation.spec.ts's it.todo tests now that Body 1 is rotated too
 * (see plans/deployment/phase-3-summary.md).
 */

import { createPublicClient, http, parseAbi, type Hex } from 'viem';
import { ARBITRUM_RPC_URL, REGISTRY_CONTRACT_ADDRESS } from './liveCard.js';
import { pinPolicyDocument, type PinnedPolicy } from './pinPolicy.js';
import { buildAndSignGovernanceOp, submitGovernanceTx, authorizeDevPressUnderPolicy, payloadToUint8Array, sigToUint8Array } from './governance.js';

const REGISTER_POLICY_ABI = parseAbi([
  'function registerPolicy(bytes32 policy_address, uint8[] policy_authorizer_pubkey, uint8[] governance_payload, uint8[][] governance_sigs) external',
]);
const POLICY_EXISTS_ABI = parseAbi([
  'function policyExists(bytes32 policy_address) external view returns (bool)',
]);

/**
 * Pins `policyDocument` to real dev Filebase, registers it on-chain
 * (Body 0 quorum, no-op if already registered), and authorizes the shared
 * dev press under it (Body 1 quorum, no-op if already active). Returns the
 * policy's CID and on-chain address, ready to use as `policy_id` in an
 * offer.
 */
export async function registerAndAuthorizeDevPolicy(policyDocument: unknown): Promise<PinnedPolicy> {
  const pinned = await pinPolicyDocument(policyDocument);

  const client = createPublicClient({ transport: http(ARBITRUM_RPC_URL) });
  const exists = await client.readContract({
    address: REGISTRY_CONTRACT_ADDRESS as Hex,
    abi: POLICY_EXISTS_ABI,
    functionName: 'policyExists',
    args: [pinned.policyAddress],
  });

  if (!exists) {
    const { payload, signatures } = await buildAndSignGovernanceOp('policy', ['--op', 'register_policy']);
    // registerPolicy requires a policy_authorizer_pubkey arg; this suite
    // doesn't exercise policy-authorizer-key rotation, so a placeholder is
    // fine (same convention policy_creation.spec.ts already uses).
    const placeholderPubkey = new Array(64).fill(0);
    await submitGovernanceTx('registerPolicy', REGISTER_POLICY_ABI, [
      pinned.policyAddress,
      placeholderPubkey,
      payloadToUint8Array(payload),
      signatures.map(sigToUint8Array),
    ]);
  }

  await authorizeDevPressUnderPolicy(pinned.policyAddress);

  return pinned;
}
