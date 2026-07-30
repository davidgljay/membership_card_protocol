import { describe, it, expect } from 'vitest';
import type { ChainLink } from '@membership-card-protocol/verifier';
import { evaluateRoomPredicate, type RoomPredicateDocument } from '../../src/matrix/discovery.js';

const POLICY_A = 'bafyreigh2akiscaildc-community-policy-v1';
const POLICY_B = 'bafyreiabc123-partner-org-policy-v3';
const POLICY_C = 'bafyreiznomatch-other-policy';

function chainWithPolicy(policyId: string, fields: Record<string, unknown> = {}): ChainLink[] {
  return [
    {
      card_address: '0xabc',
      public_key: 'pk',
      card_content: { policy_id: policyId, ...fields },
    },
  ];
}

describe('evaluateRoomPredicate (mirrors predicates.py test_predicates.py scenarios)', () => {
  it('matches a single entry with policy_id and satisfied field_match', () => {
    const doc: RoomPredicateDocument = {
      policies: [{ ref_type: 'cid', ref: POLICY_A, field_match: { field: 'status', regex: '^active$' } }],
    };
    const chain = chainWithPolicy(POLICY_A, { status: 'active' });
    expect(evaluateRoomPredicate(doc, chain)).toBe(true);
  });

  it('denies a single entry whose field_match fails', () => {
    const doc: RoomPredicateDocument = {
      policies: [{ ref_type: 'cid', ref: POLICY_A, field_match: { field: 'status', regex: '^active$' } }],
    };
    const chain = chainWithPolicy(POLICY_A, { status: 'suspended' });
    expect(evaluateRoomPredicate(doc, chain)).toBe(false);
  });

  it('denies a non-matching policy_id', () => {
    const doc: RoomPredicateDocument = { policies: [{ ref_type: 'cid', ref: POLICY_A }] };
    const chain = chainWithPolicy(POLICY_C);
    expect(evaluateRoomPredicate(doc, chain)).toBe(false);
  });

  it('any_of across multiple entries: eligible when only one entry matches', () => {
    const doc: RoomPredicateDocument = {
      policies: [
        { ref_type: 'cid', ref: POLICY_A, field_match: { field: 'status', regex: '^active$' } },
        { ref_type: 'pointer', ref: '0xpartner', resolved_ref: POLICY_B },
      ],
    };
    // Fails entry 1 (wrong policy_id), satisfies entry 2 (resolved_ref, no field_match).
    const chain = chainWithPolicy(POLICY_B);
    expect(evaluateRoomPredicate(doc, chain)).toBe(true);
  });

  it('any_of across multiple entries: denied when none match', () => {
    const doc: RoomPredicateDocument = {
      policies: [
        { ref_type: 'cid', ref: POLICY_A },
        { ref_type: 'pointer', ref: '0xpartner', resolved_ref: POLICY_B },
      ],
    };
    const chain = chainWithPolicy(POLICY_C);
    expect(evaluateRoomPredicate(doc, chain)).toBe(false);
  });

  it('uses resolved_ref, not the raw pointer address, for pointer-originated entries', () => {
    const doc: RoomPredicateDocument = {
      policies: [{ ref_type: 'pointer', ref: '0x9f2c-partner-org-policy-address', resolved_ref: POLICY_B }],
    };
    const chain = chainWithPolicy(POLICY_B);
    expect(evaluateRoomPredicate(doc, chain)).toBe(true);
  });

  it('denies an empty policies list', () => {
    expect(evaluateRoomPredicate({ policies: [] }, chainWithPolicy(POLICY_A))).toBe(false);
  });
});
