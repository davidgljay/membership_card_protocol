import { describe, it, expect } from 'vitest';
import { CardVerifier } from '@membership-card-protocol/verifier';
import type { IpfsProvider, RpcProvider } from '@membership-card-protocol/verifier';
import { createCardVerifier } from '../../src/verification/CardVerifier.js';

// keccak256-shaped (64 lowercase hex chars, no 0x prefix) fixture addresses,
// matching the address format the verifier package's own crypto.ts and
// test fixtures use.
const TRUSTED_ROOT = 'aa'.repeat(32);
const UNKNOWN_CARD = 'bb'.repeat(32);

function fakeRpc(overrides: Partial<RpcProvider> = {}): RpcProvider {
  return {
    getCardEntry: async (address) => {
      if (address === TRUSTED_ROOT) {
        return {
          log_head_cid: '',
          policy_address: '',
          last_press_address: '',
          forward_to: null,
          exists: true,
        };
      }
      return null;
    },
    isPolicyAuthorizer: async () => false,
    getPressAuthorization: async () => null,
    getSubCardEntry: async () => null,
    getLogEntries: async () => [],
    getEasAnnotations: async () => [],
    ...overrides,
  };
}

const fakeIpfs: IpfsProvider = {
  fetch: async () => {
    throw new Error('not used by this fixture — fetchAnnotations is false and no card doc is fetched');
  },
};

/**
 * Smoke-tests the Step 1.4 factory: a single shared CardVerifier is
 * constructed from SDK-level config, and verifyCard()'s result reaches the
 * caller unmodified — no re-derivation of chain-walk or revocation logic
 * inside client-sdk.
 */
describe('createCardVerifier', () => {
  it('is a real CardVerifier instance from the verifier package', () => {
    const verifier = createCardVerifier({
      rpc: fakeRpc(),
      appCertificationRoot: TRUSTED_ROOT,
    });
    expect(verifier).toBeInstanceOf(CardVerifier);
  });

  it('known-good fixture: verifyCard reaches the trusted root and is currently valid', async () => {
    const verifier = createCardVerifier({
      rpc: fakeRpc(),
      ipfs: fakeIpfs,
      appCertificationRoot: TRUSTED_ROOT,
      trustedRoots: [TRUSTED_ROOT],
      fetchAnnotations: false,
    });

    const result = await verifier.verifyCard(TRUSTED_ROOT);

    expect(result.chain_reaches_trusted_root).toBe(true);
    expect(result.is_currently_valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('known-bad fixture: verifyCard hard-rejects a card the registry has no entry for', async () => {
    const verifier = createCardVerifier({
      rpc: fakeRpc(),
      ipfs: fakeIpfs,
      appCertificationRoot: TRUSTED_ROOT,
      trustedRoots: [TRUSTED_ROOT],
      fetchAnnotations: false,
    });

    const result = await verifier.verifyCard(UNKNOWN_CARD);

    expect(result.chain_reaches_trusted_root).toBe('skipped');
    expect(result.errors.some((e) => e.code === 'CARD_NOT_FOUND')).toBe(true);
  });

  it('defaults ipfs to FilebaseIpfsProvider when not supplied', async () => {
    const verifier = createCardVerifier({
      rpc: fakeRpc(),
      appCertificationRoot: TRUSTED_ROOT,
      trustedRoots: [TRUSTED_ROOT],
      fetchAnnotations: false,
    });

    // The default IpfsProvider is never exercised by verifyCard() on a
    // trusted-root card with fetchAnnotations: false — this just confirms
    // construction succeeds without an explicit ipfs option.
    const result = await verifier.verifyCard(TRUSTED_ROOT);
    expect(result.chain_reaches_trusted_root).toBe(true);
  });
});
