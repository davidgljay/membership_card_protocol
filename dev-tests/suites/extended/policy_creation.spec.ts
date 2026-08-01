/**
 * `specs/process_specs/policy_creation.md`, against the live dev
 * deployment. Adapted from
 * integration_tests/suites/extended/policy_creation.spec.ts — real
 * adaptation, not a mechanical port.
 *
 * Per plans/deployment/dev-governance-rotation-runbook.md, dev-tests now
 * holds a narrower, dev-tests-owned 2-of-3 quorum for Body 0
 * (RootPolicyBody) specifically — so "Phase 0: registers a new policy"
 * below is a real, fully-working RegisterPolicy call using
 * `../../support/governance.ts`, not `ensureGovernanceBootstrap`.
 *
 * **Partial resolution, not full**: dev-tests was NOT granted Body 1
 * (PressRegistryBody) authority — only Body 0 and Body 2 were rotated (see
 * the runbook's scope discussion). `AuthorizePress` is gated by Body 1, so
 * a freshly-`RegisterPolicy`'d policy still can't have the shared dev press
 * authorized under it here — the original suite's "Phase 2 + Phase 3:
 * authorizer issues policy card" and "Full happy path" tests, which both
 * need that authorization to issue a card under the new policy, remain
 * `it.todo` below. Resolving those further would mean also rotating Body 1
 * — a decision not yet made, parallel to the Body 0/2 rotation.
 */

import { describe, it, expect } from 'vitest';
import { createPublicClient, http, parseAbi, type Hex } from 'viem';
import { ARBITRUM_RPC_URL, REGISTRY_CONTRACT_ADDRESS } from '../../support/liveCard.js';
import { buildAndSignGovernanceOp, submitGovernanceTx, payloadToUint8Array, sigToUint8Array } from '../../support/governance.js';

/**
 * A test-specific policy document with real field_definitions and
 * approved_presses. This is the shape required by
 * specs/object_specs/protocol-objects.md §2.
 */
interface PolicyCardDocument {
  policy_id: string;
  field_definitions: Array<{
    name: string;
    type: string;
    required?: boolean;
    description?: string;
    update_policy?: Record<string, unknown>;
  }>;
  approved_presses: string[];
  allow_open_offers?: boolean;
  valid_until?: string;
  [key: string]: unknown;
}

describe('policy_creation.md (live dev deployment)', () => {
  it('Phase 1: assembles a policy document with field_definitions and approved_presses', () => {
    const policyDoc: PolicyCardDocument = {
      policy_id: 'test-policy-' + Date.now(),
      field_definitions: [
        {
          name: 'member_id',
          type: 'string',
          required: true,
          description: 'Unique member identifier',
          update_policy: { is_holder: true },
        },
        {
          name: 'membership_tier',
          type: 'string',
          required: false,
          description: 'Tier level (gold, silver, bronze)',
        },
        {
          name: 'expiry_date',
          type: 'timestamp',
          required: false,
          description: 'Membership expiry',
        },
      ],
      approved_presses: [],
      allow_open_offers: false,
      valid_until: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
    };

    expect(policyDoc.field_definitions).toBeDefined();
    expect(policyDoc.field_definitions.length).toBeGreaterThan(0);
    expect(policyDoc.field_definitions[0]).toHaveProperty('name');
    expect(policyDoc.field_definitions[0]).toHaveProperty('type');

    expect(policyDoc).not.toHaveProperty('recipient_pubkey');
    expect(policyDoc).not.toHaveProperty('issuer_signature');
    expect(policyDoc).not.toHaveProperty('holder_signature');
    expect(policyDoc).not.toHaveProperty('press_signature');
  });

  it('Phase 0: registers a new policy in the governance registry (RegisterPolicy)', async () => {
    // A real RegisterPolicy call, using dev-tests' own Body 0 quorum --
    // no local devnode bootstrap involved. The policy address here is
    // synthetic (not derived from a real pinned IPFS document) since this
    // test's only subject is the governance registration mechanic itself.
    const policyAddress = ('0x' + Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('hex')) as Hex;

    const { payload, signatures } = await buildAndSignGovernanceOp('policy', ['--op', 'register_policy']);

    const REGISTER_POLICY_ABI = parseAbi([
      'function registerPolicy(bytes32 policy_address, uint8[] policy_authorizer_pubkey, uint8[] governance_payload, uint8[][] governance_sigs) external',
    ]);
    // Placeholder authorizer pubkey -- registerPolicy requires the arg but
    // this test doesn't exercise policy-authorizer-key rotation.
    const placeholderPubkey = new Array(64).fill(0);

    await submitGovernanceTx('registerPolicy', REGISTER_POLICY_ABI, [
      policyAddress,
      placeholderPubkey,
      payloadToUint8Array(payload),
      signatures.map(sigToUint8Array),
    ]);

    const storageClient = createPublicClient({ transport: http(ARBITRUM_RPC_URL) });
    const exists = await storageClient.readContract({
      address: REGISTRY_CONTRACT_ADDRESS as Hex,
      abi: parseAbi(['function policyExists(bytes32 policy_address) external view returns (bool)']),
      functionName: 'policyExists',
      args: [policyAddress],
    });
    expect(exists).toBe(true);
  });

  it.todo(
    'Phase 2 + Phase 3: authorizer issues policy card and it registers on-chain -- ' +
      'requires AuthorizePress (Body 1: PressRegistryBody), which dev-tests was not granted ' +
      'authority over (only Body 0/RootPolicyBody and Body 2/DnsGovernanceBody were rotated -- ' +
      'see plans/deployment/dev-governance-rotation-runbook.md). A freshly-registered policy ' +
      'has no press authorized to issue under it here.'
  );

  it.todo(
    'Full happy path: policy assembly → governance bootstrap → issuance → registration end-to-end -- ' +
      'same Body 1 gap as above.'
  );

  it.todo('Error path: press sub-card pointer not in approved_presses — press rejects finalization (requires multi-press environment)');
});
