import { describe, it, expect, vi } from 'vitest';
import type { IpfsProvider, RpcProvider } from '@membership-card-protocol/verifier';
import { createCardVerifier } from '../../src/verification/CardVerifier.js';
import { requestSubCard } from '../../src/subcards/requestSubCard.js';
import { handleSubCardRequest } from '../../src/subcards/handleSubCardRequest.js';
import { assembleSubCardConsent } from '../../src/subcards/consent.js';
import { mlDsa44GenerateKeypair, mlDsa44Sign } from '../../src/crypto/mldsa.js';
import { keccak256 } from '../../src/crypto/hashes.js';
import type { WalletAppCardIdentity } from '../../src/wallet/deviceSubCard.js';
import type { SecureKeyProvider } from '../../src/providers/SecureKeyProvider.js';

const GOVERNANCE_APP_CERT_ROOT = 'ff'.repeat(32);

const fakeIpfs: IpfsProvider = {
  fetch: async () => {
    throw new Error('not used — fetchAnnotations is false');
  },
};

function makeFakeSecureKeyProvider(): SecureKeyProvider {
  const secretKeys = new Map<string, Uint8Array>();
  return {
    generateKey: vi.fn(async (keyId: string) => {
      const keypair = mlDsa44GenerateKeypair();
      secretKeys.set(keyId, keypair.secretKey);
      return keypair.publicKey;
    }),
    sign: vi.fn(async (keyId: string, message: Uint8Array) => {
      const secretKey = secretKeys.get(keyId);
      if (!secretKey) throw new Error('no key');
      return mlDsa44Sign(secretKey, message);
    }),
    getPublicKey: vi.fn(async () => undefined),
    delete: vi.fn(),
  };
}

function makeFakeAppCard(): WalletAppCardIdentity {
  const keypair = mlDsa44GenerateKeypair();
  return {
    cardPointer: keccak256(keypair.publicKey),
    publicKey: keypair.publicKey,
    sign: (message: Uint8Array) => mlDsa44Sign(keypair.secretKey, message),
  };
}

function makeHappyPathRpc(appCardAddress: string): RpcProvider {
  return {
    getCardEntry: async (address) =>
      address === appCardAddress
        ? { log_head_cid: 'cid', policy_address: 'policy', last_press_address: 'press', forward_to: null, exists: true }
        : null,
    isPolicyAuthorizer: async (address) => address === appCardAddress,
    getPressAuthorization: async () => null,
    getSubCardEntry: async () => null,
    getLogEntries: async () => [],
    getEasAnnotations: async () => [],
  };
}

async function makeValidatedRequest(capabilities: string[]) {
  const secureKeyProvider = makeFakeSecureKeyProvider();
  const appCard = makeFakeAppCard();
  const holder = mlDsa44GenerateKeypair();
  const { document } = await requestSubCard({
    secureKeyProvider,
    subCardKeyId: 'app-sub-card-key',
    appCard,
    holderPrimaryCard: keccak256(holder.publicKey),
    holderPrimaryCardPubkey: holder.publicKey,
    capabilities,
    attestationLevel: 'T1',
  });

  const appCardAddress = keccak256(appCard.publicKey);
  const cardVerifier = createCardVerifier({
    rpc: makeHappyPathRpc(appCardAddress),
    ipfs: fakeIpfs,
    appCertificationRoot: GOVERNANCE_APP_CERT_ROOT,
    trustedRoots: [GOVERNANCE_APP_CERT_ROOT, appCardAddress],
  });
  const validated = await handleSubCardRequest({ cardVerifier, request: document });
  if (!validated.valid) throw new Error('fixture setup failed: request did not validate');
  return validated;
}

describe('assembleSubCardConsent', () => {
  it('narrows requested capabilities to the wallet-grantable subset (3 requested, wallet grants 2 -> output reflects 2)', async () => {
    const validated = await makeValidatedRequest(['auth_response', 'exchange_offer', 'note']);

    const consent = assembleSubCardConsent({
      validated,
      appIdentity: { name: 'Example App', version: '1.0.0', publisher: 'Example Org' },
      walletGrantableCapabilities: ['auth_response', 'exchange_offer'], // wallet config omits "note"
    });

    expect(consent.requestedCapabilities).toEqual(['auth_response', 'exchange_offer', 'note']);
    expect(consent.grantableCapabilities).toEqual(['auth_response', 'exchange_offer']);
    expect(consent.grantableCapabilities).toHaveLength(2);
    expect(consent.appIdentity).toEqual({ name: 'Example App', version: '1.0.0', publisher: 'Example Org' });
    expect(consent.annotationWarnings).toEqual([]);
    expect(consent.validatedRequest).toBe(validated);
  });

  it('includes a suggested valid_until only when supplied', async () => {
    const validated = await makeValidatedRequest(['auth_response']);

    const withSuggestion = assembleSubCardConsent({
      validated,
      appIdentity: { name: 'Example App' },
      walletGrantableCapabilities: ['auth_response'],
      suggestedValidUntil: '2027-01-01T00:00:00.000Z',
    });
    expect(withSuggestion.suggestedValidUntil).toBe('2027-01-01T00:00:00.000Z');

    const withoutSuggestion = assembleSubCardConsent({
      validated,
      appIdentity: { name: 'Example App' },
      walletGrantableCapabilities: ['auth_response'],
    });
    expect(withoutSuggestion.suggestedValidUntil).toBeUndefined();
  });

  it('grants nothing when the wallet config has no overlap with requested capabilities', async () => {
    const validated = await makeValidatedRequest(['auth_response']);

    const consent = assembleSubCardConsent({
      validated,
      appIdentity: { name: 'Example App' },
      walletGrantableCapabilities: ['unrelated_capability'],
    });

    expect(consent.grantableCapabilities).toEqual([]);
  });
});
