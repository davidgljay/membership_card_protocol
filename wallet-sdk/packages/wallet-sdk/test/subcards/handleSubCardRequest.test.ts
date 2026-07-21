import { describe, it, expect, vi } from 'vitest';
import {
  createCardVerifier,
  requestSubCard,
  mlDsa44GenerateKeypair,
  mlDsa44Sign,
  keccak256,
} from '@membership-card-protocol/app-sdk';
import type {
  IpfsProvider,
  RpcProvider,
  WalletAppCardIdentity,
  SecureKeyProvider,
} from '@membership-card-protocol/app-sdk';
import { handleSubCardRequest } from '../../src/subcards/handleSubCardRequest.js';

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
    // Must equal keccak256(publicKey) — handleSubCardRequest's own binding
    // check exercises this, unlike requestSubCard, which never needed
    // app_card/app_card_pubkey to be self-consistent.
    cardPointer: keccak256(keypair.publicKey),
    publicKey: keypair.publicKey,
    sign: (message: Uint8Array) => mlDsa44Sign(keypair.secretKey, message),
  };
}

const GOVERNANCE_APP_CERT_ROOT = 'ff'.repeat(32);

const fakeIpfs: IpfsProvider = {
  fetch: async () => {
    throw new Error('not used — fetchAnnotations is false');
  },
};

/** A stub RPC where `appCardAddress` is registered, reaches the app-cert root, and is not revoked, unless overridden. */
function makeHappyPathRpc(appCardAddress: string, overrides: Partial<RpcProvider> = {}): RpcProvider {
  return {
    getCardEntry: async (address) =>
      address === appCardAddress
        ? { log_head_cid: 'cid', policy_address: 'policy', last_press_address: 'press', forward_to: null, exists: true }
        : null,
    isPolicyAuthorizer: async (address) => address === appCardAddress,
    getPressAuthorization: async () => null,
    getSubCardEntry: async () => null,
    getCardEventLog: async () => [],
    getEasAnnotations: async () => {
      throw new Error('getEasAnnotations should never be called — fetchAnnotations is false (OQ-SDK-11)');
    },
    ...overrides,
  };
}

async function makeRequest() {
  const secureKeyProvider = makeFakeSecureKeyProvider();
  const appCard = makeFakeAppCard();
  const holder = mlDsa44GenerateKeypair();
  const { document } = await requestSubCard({
    secureKeyProvider,
    subCardKeyId: 'app-sub-card-key',
    appCard,
    holderPrimaryCard: keccak256(holder.publicKey),
    holderPrimaryCardPubkey: holder.publicKey,
    capabilities: ['auth_response'],
    attestationLevel: 'T1',
  });
  return { document, appCard, holder };
}

describe('handleSubCardRequest', () => {
  it('validates a well-formed request: signature, both bindings, and a trusted, non-revoked app card chain', async () => {
    const { document, appCard } = await makeRequest();
    const appCardAddress = keccak256(appCard.publicKey);
    const rpc = makeHappyPathRpc(appCardAddress);
    const cardVerifier = createCardVerifier({
      rpc,
      ipfs: fakeIpfs,
      appCertificationRoot: GOVERNANCE_APP_CERT_ROOT,
      trustedRoots: [GOVERNANCE_APP_CERT_ROOT, appCardAddress],
      fetchAnnotations: false,
    });

    const result = await handleSubCardRequest({ cardVerifier, request: document });

    expect(result.valid).toBe(true);
    if (!result.valid) throw new Error('unreachable');
    expect(result.request).toBe(document);
    expect(result.appCardVerification.chain_reaches_trusted_root).toBe(true);
    // verifyCard is called with no pubkey here, so CardVerifier always
    // returns "skipped" for is_currently_valid (card_verifier.md §7.4) —
    // not a real revocation determination.
    expect(result.appCardVerification.is_currently_valid).toBe('skipped');
  });

  it('rejects on holder_primary_card binding mismatch', async () => {
    const { document, appCard } = await makeRequest();
    const wrongHolder = mlDsa44GenerateKeypair();
    const tampered = { ...document, holder_primary_card: keccak256(wrongHolder.publicKey) };
    const appCardAddress = keccak256(appCard.publicKey);
    const cardVerifier = createCardVerifier({
      rpc: makeHappyPathRpc(appCardAddress),
      ipfs: fakeIpfs,
      appCertificationRoot: GOVERNANCE_APP_CERT_ROOT,
      trustedRoots: [GOVERNANCE_APP_CERT_ROOT, appCardAddress],
    });

    const result = await handleSubCardRequest({ cardVerifier, request: tampered });
    expect(result.valid).toBe(false);
    if (result.valid) throw new Error('unreachable');
    expect(result.code).toBe('holder_primary_card_binding_mismatch');
  });

  it('rejects on app_card binding mismatch', async () => {
    const { document, appCard } = await makeRequest();
    const wrongApp = mlDsa44GenerateKeypair();
    const tampered = { ...document, app_card: keccak256(wrongApp.publicKey) };
    const appCardAddress = keccak256(appCard.publicKey);
    const cardVerifier = createCardVerifier({
      rpc: makeHappyPathRpc(appCardAddress),
      ipfs: fakeIpfs,
      appCertificationRoot: GOVERNANCE_APP_CERT_ROOT,
      trustedRoots: [GOVERNANCE_APP_CERT_ROOT, appCardAddress],
    });

    const result = await handleSubCardRequest({ cardVerifier, request: tampered });
    expect(result.valid).toBe(false);
    if (result.valid) throw new Error('unreachable');
    expect(result.code).toBe('app_card_binding_mismatch');
  });

  it('rejects on an invalid app_signature', async () => {
    const { document, appCard } = await makeRequest();
    const tampered = { ...document, capabilities: [...document.capabilities, 'a_new_capability_not_signed_for'] };
    const appCardAddress = keccak256(appCard.publicKey);
    const cardVerifier = createCardVerifier({
      rpc: makeHappyPathRpc(appCardAddress),
      ipfs: fakeIpfs,
      appCertificationRoot: GOVERNANCE_APP_CERT_ROOT,
      trustedRoots: [GOVERNANCE_APP_CERT_ROOT, appCardAddress],
    });

    const result = await handleSubCardRequest({ cardVerifier, request: tampered });
    expect(result.valid).toBe(false);
    if (result.valid) throw new Error('unreachable');
    expect(result.code).toBe('app_signature_invalid');
  });

  it('rejects when the app card chain does not reach the governance app-certification root', async () => {
    const { document, appCard } = await makeRequest();
    const appCardAddress = keccak256(appCard.publicKey);
    // Registered, but NOT a trusted root / policy authorizer.
    const rpc = makeHappyPathRpc(appCardAddress, { isPolicyAuthorizer: async () => false });
    const cardVerifier = createCardVerifier({
      rpc,
      ipfs: fakeIpfs,
      appCertificationRoot: GOVERNANCE_APP_CERT_ROOT,
      trustedRoots: [], // deliberately excludes appCardAddress and the governance root
    });

    const result = await handleSubCardRequest({ cardVerifier, request: document });
    expect(result.valid).toBe(false);
    if (result.valid) throw new Error('unreachable');
    expect(result.code).toBe('app_card_chain_not_trusted');
  });

  it('does not reject a request over a revoked app card — verifyCard has no pubkey to work from here, so it cannot determine revocation (card_verifier.md §7.4)', async () => {
    const { document, appCard } = await makeRequest();
    const appCardAddress = keccak256(appCard.publicKey);
    const rpc = makeHappyPathRpc(appCardAddress, {
      getCardEventLog: async () => [
        {
          card_address: appCardAddress,
          update_code: 811,
          cid: 'revocation-cid',
          effective_date: '2020-01-01T00:00:00.000Z',
        },
      ],
    });
    const cardVerifier = createCardVerifier({
      rpc,
      ipfs: fakeIpfs,
      appCertificationRoot: GOVERNANCE_APP_CERT_ROOT,
      trustedRoots: [GOVERNANCE_APP_CERT_ROOT, appCardAddress],
    });

    const result = await handleSubCardRequest({ cardVerifier, request: document });
    expect(result.valid).toBe(true);
    if (!result.valid) throw new Error('unreachable');
    expect(result.appCardVerification.is_currently_valid).toBe('skipped');
  });

  it('surfaces a CardVerifier error as a rejection, not an uncaught exception', async () => {
    const { document, appCard } = await makeRequest();
    const appCardAddress = keccak256(appCard.publicKey);
    const cardVerifier = createCardVerifier({
      rpc: makeHappyPathRpc(appCardAddress),
      ipfs: fakeIpfs,
      appCertificationRoot: GOVERNANCE_APP_CERT_ROOT,
      trustedRoots: [GOVERNANCE_APP_CERT_ROOT, appCardAddress],
    });
    vi.spyOn(cardVerifier, 'verifyCard').mockRejectedValue(new Error('registry RPC unavailable'));

    const result = await handleSubCardRequest({ cardVerifier, request: document });
    expect(result.valid).toBe(false);
    if (result.valid) throw new Error('unreachable');
    expect(result.code).toBe('verification_error');
    expect(result.reason).toMatch(/registry RPC unavailable/);
  });

  it('never calls the annotation board (OQ-SDK-11)', async () => {
    const { document, appCard } = await makeRequest();
    const appCardAddress = keccak256(appCard.publicKey);
    const getEasAnnotations = vi.fn(async () => {
      throw new Error('should never be called');
    });
    const rpc = makeHappyPathRpc(appCardAddress, { getEasAnnotations });
    const cardVerifier = createCardVerifier({
      rpc,
      ipfs: fakeIpfs,
      appCertificationRoot: GOVERNANCE_APP_CERT_ROOT,
      trustedRoots: [GOVERNANCE_APP_CERT_ROOT, appCardAddress],
      fetchAnnotations: false,
    });

    const result = await handleSubCardRequest({ cardVerifier, request: document });
    expect(result.valid).toBe(true);
    expect(getEasAnnotations).not.toHaveBeenCalled();
  });
});
