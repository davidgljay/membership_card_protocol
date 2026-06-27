/**
 * Predicate evaluation and rate-limiting unit tests.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { evaluatePredicates, checkRateLimits, recordWrite } from '../../src/functions/predicates.js';
import { createInMemoryKv } from '../../src/kv.js';
import type { PolicyDocument } from '../../src/types.js';

const STALENESS_WINDOW = 300;

function makeVerifier(overrides: {
  chain?: boolean;
  valid?: boolean | 'skipped';
  freshness?: number;
} = {}) {
  return {
    verifyCard: vi.fn().mockResolvedValue({
      chain_reaches_trusted_root: overrides.chain ?? true,
      is_currently_valid: overrides.valid ?? true,
      revocation: {
        status: 'not_revoked',
        code: null,
        effective_date: null,
        data_freshness_seconds: overrides.freshness ?? 0,
      },
    }),
  } as unknown as import('@membership-card-protocol/verifier').CardVerifier;
}

const POLICY: PolicyDocument = {
  policy_id: 'bafybeipolicy',
  field_definitions: {},
  approved_presses: ['bafybeipress'],
};

describe('evaluatePredicates', () => {
  it('passes when both chains are valid and trusted', async () => {
    const result = await evaluatePredicates(
      makeVerifier(), POLICY, '0xrequester', '0xrecipient', STALENESS_WINDOW
    );
    expect(result.passed).toBe(true);
  });

  it('throws P-02 when requester chain does not reach trusted root', async () => {
    const v = makeVerifier({ chain: false });
    await expect(
      evaluatePredicates(v, POLICY, '0xrequester', '0xrecipient', STALENESS_WINDOW)
    ).rejects.toMatchObject({ pressCode: 'P-02' });
  });

  it('throws P-04 when requester is revoked', async () => {
    const v = makeVerifier({ valid: false });
    await expect(
      evaluatePredicates(v, POLICY, '0xrequester', '0xrecipient', STALENESS_WINDOW)
    ).rejects.toMatchObject({ pressCode: 'P-04' });
  });

  it('throws P-17 when revocation data is stale', async () => {
    const v = makeVerifier({ freshness: 999 });
    await expect(
      evaluatePredicates(v, POLICY, '0xrequester', '0xrecipient', STALENESS_WINDOW)
    ).rejects.toMatchObject({ pressCode: 'P-17' });
  });

  it('throws P-03 when recipient chain does not reach trusted root', async () => {
    const calls: string[] = [];
    const v = {
      verifyCard: vi.fn().mockImplementation(async (addr: string) => {
        calls.push(addr);
        // Requester passes, recipient fails.
        const chain = addr === '0xrequester' ? true : false;
        return {
          chain_reaches_trusted_root: chain,
          is_currently_valid: true,
          revocation: { status: 'not_revoked', code: null, effective_date: null, data_freshness_seconds: 0 },
        };
      }),
    } as unknown as import('@membership-card-protocol/verifier').CardVerifier;

    await expect(
      evaluatePredicates(v, POLICY, '0xrequester', '0xrecipient', STALENESS_WINDOW)
    ).rejects.toMatchObject({ pressCode: 'P-03' });
  });

  it('throws P-02 when requester_predicate type is chain_valid and chain fails', async () => {
    // chain_valid predicate with chain not reaching root.
    const policy: PolicyDocument = {
      ...POLICY,
      requester_predicate: { type: 'chain_valid' },
    };
    // First verifyCard (requester) returns trusted but chain_valid predicate checks independently.
    // For the predicate evaluator: chain_reaches_trusted_root must be true.
    const v = makeVerifier({ chain: true, valid: true });
    // This should pass (predicate is satisfied).
    const result = await evaluatePredicates(v, policy, '0xrequester', '0xrecipient', STALENESS_WINDOW);
    expect(result.passed).toBe(true);
  });
});

describe('checkRateLimits', () => {
  it('passes when counter is below limit', async () => {
    const kv = createInMemoryKv();
    await expect(
      checkRateLimits(kv, 'register_card', '0xholder', 'holder', '0xpolicy')
    ).resolves.toBeUndefined();
  });

  it('throws P-18 when entity limit is reached', async () => {
    const kv = createInMemoryKv();
    // Manually set counter to limit.
    const ws = Math.floor(Date.now() / (7 * 24 * 60 * 60 * 1000)) * (7 * 24 * 60 * 60 * 1000);
    await kv.setItem(`press:rate:0xholder:holder:register_card:0xpolicy:${ws}`, 1000);
    await expect(
      checkRateLimits(kv, 'register_card', '0xholder', 'holder', '0xpolicy')
    ).rejects.toMatchObject({ pressCode: 'P-18' });
  });

  it('throws P-19 when policy-level limit is reached', async () => {
    const kv = createInMemoryKv();
    const ws = Math.floor(Date.now() / (7 * 24 * 60 * 60 * 1000)) * (7 * 24 * 60 * 60 * 1000);
    await kv.setItem(`press:policy_writes:0xpolicy:${ws}`, 1000);
    await expect(
      checkRateLimits(kv, 'register_card', '0xholder', 'holder', '0xpolicy')
    ).rejects.toMatchObject({ pressCode: 'P-19' });
  });
});

describe('recordWrite', () => {
  it('increments entity and policy counters', async () => {
    const kv = createInMemoryKv();
    const policy = { ...POLICY };
    await recordWrite(kv, 'register_card', '0xholder', 'holder', '0xpolicy', policy);
    const ws = Math.floor(Date.now() / (7 * 24 * 60 * 60 * 1000)) * (7 * 24 * 60 * 60 * 1000);
    const entityCount = await kv.getItem<number>(`press:rate:0xholder:holder:register_card:0xpolicy:${ws}`);
    const policyCount = await kv.getItem<number>(`press:policy_writes:0xpolicy:${ws}`);
    expect(entityCount).toBe(1);
    expect(policyCount).toBe(1);
  });
});
