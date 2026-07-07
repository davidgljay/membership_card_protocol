import { describe, it, expect, vi } from 'vitest';
import {
  createCardVerifier,
  assembleAndSignTargetedOffer,
  assembleAndSignOpenOffer,
  mlDsa44GenerateKeypair,
  mlDsa44Sign,
  keccak256,
} from '@membership-card-protocol/app-sdk';
import { bytesToBase64Url } from '@membership-card-protocol/app-sdk';
import type { IpfsProvider, RpcProvider, SecureKeyProvider } from '@membership-card-protocol/app-sdk';
import { reviewTargetedOffer, reviewOpenOffer } from '../../src/offers/offerVerification.js';

function makeFakeSecureKeyProvider(keyId: string, keypair: { publicKey: Uint8Array; secretKey: Uint8Array }): SecureKeyProvider {
  return {
    generateKey: vi.fn(async () => keypair.publicKey),
    sign: vi.fn(async (id: string, message: Uint8Array) => {
      if (id !== keyId) throw new Error(`no key for ${id}`);
      return mlDsa44Sign(keypair.secretKey, message);
    }),
    getPublicKey: vi.fn(async (id: string) => (id === keyId ? keypair.publicKey : undefined)),
    delete: vi.fn(),
  };
}

const POLICY_ADDRESS = 'cc'.repeat(32);
const PRESS_CARD = 'dd'.repeat(32);

const fakeIpfs: IpfsProvider = {
  fetch: async () => {
    throw new Error('not used — fetchAnnotations is false and verifyCard does not fetch card docs today');
  },
};

/** Builds a fake RPC with a registered, trusted-root issuer and an authorized press, ready for happy-path tests. */
function makeHappyPathRpc(issuerAddress: string): RpcProvider {
  return {
    getCardEntry: async (address) =>
      address === issuerAddress
        ? { log_head_cid: 'cid', policy_address: POLICY_ADDRESS, last_press_address: PRESS_CARD, forward_to: null, exists: true }
        : null,
    isPolicyAuthorizer: async (address) => address === issuerAddress,
    getPressAuthorization: async (policyAddress, pressAddress) =>
      policyAddress === POLICY_ADDRESS && pressAddress === PRESS_CARD
        ? { press_public_key: 'x', mldsa44_key_hash: 'y', active: true, authorized_at: '2026-01-01T00:00:00.000Z', revoked_at: null }
        : null,
    getSubCardEntry: async () => null,
    getLogEntries: async () => [],
    getEasAnnotations: async () => [],
  };
}

describe('reviewTargetedOffer', () => {
  it('approves a fully valid offer', async () => {
    const issuer = mlDsa44GenerateKeypair();
    const issuerAddress = keccak256(issuer.publicKey);
    const secureKeyProvider = makeFakeSecureKeyProvider('issuer-key', issuer);
    const rpc = makeHappyPathRpc(issuerAddress);
    const cardVerifier = createCardVerifier({ rpc, ipfs: fakeIpfs, appCertificationRoot: issuerAddress, trustedRoots: [issuerAddress] });

    const offer = await assembleAndSignTargetedOffer({
      secureKeyProvider,
      issuerSigningKeyId: 'issuer-key',
      policyId: 'policy-cid',
      issuerCard: issuerAddress,
      pressCard: PRESS_CARD,
      ancestryPubkeys: [issuer.publicKey],
      fieldValues: { tier: 'gold' },
    });

    const result = await reviewTargetedOffer(offer, { cardVerifier, rpc, policyAddress: POLICY_ADDRESS });

    expect(result.approved).toBe(true);
    if (!result.approved) throw new Error('unreachable');
    expect(result.offer).toBe(offer);
    expect(result.issuerVerification.chain_reaches_trusted_root).toBe(true);
    expect(result.pressAdvisoryWarning).toBeUndefined();
  });

  it('rejects on ancestry_pubkeys[0]/issuer_card binding mismatch', async () => {
    const issuer = mlDsa44GenerateKeypair();
    const wrongIssuer = mlDsa44GenerateKeypair();
    const issuerAddress = keccak256(issuer.publicKey);
    const secureKeyProvider = makeFakeSecureKeyProvider('issuer-key', issuer);
    const rpc = makeHappyPathRpc(issuerAddress);
    const cardVerifier = createCardVerifier({ rpc, ipfs: fakeIpfs, appCertificationRoot: issuerAddress });

    const offer = await assembleAndSignTargetedOffer({
      secureKeyProvider,
      issuerSigningKeyId: 'issuer-key',
      policyId: 'policy-cid',
      issuerCard: issuerAddress,
      pressCard: PRESS_CARD,
      // Wrong ancestry pubkey: doesn't hash to issuerCard.
      ancestryPubkeys: [wrongIssuer.publicKey],
      fieldValues: {},
    });

    const result = await reviewTargetedOffer(offer, { cardVerifier, rpc, policyAddress: POLICY_ADDRESS });
    expect(result.approved).toBe(false);
    if (result.approved) throw new Error('unreachable');
    expect(result.code).toBe('issuer_binding_mismatch');
  });

  it('rejects an offer with an empty ancestry_pubkeys (no issuer key to verify against)', async () => {
    const issuer = mlDsa44GenerateKeypair();
    const issuerAddress = keccak256(issuer.publicKey);
    const secureKeyProvider = makeFakeSecureKeyProvider('issuer-key', issuer);
    const rpc = makeHappyPathRpc(issuerAddress);
    const cardVerifier = createCardVerifier({ rpc, ipfs: fakeIpfs, appCertificationRoot: issuerAddress });

    const offer = await assembleAndSignTargetedOffer({
      secureKeyProvider,
      issuerSigningKeyId: 'issuer-key',
      policyId: 'policy-cid',
      issuerCard: issuerAddress,
      pressCard: PRESS_CARD,
      ancestryPubkeys: [],
      fieldValues: {},
    });

    const result = await reviewTargetedOffer(offer, { cardVerifier, rpc, policyAddress: POLICY_ADDRESS });
    expect(result.approved).toBe(false);
    if (result.approved) throw new Error('unreachable');
    expect(result.code).toBe('issuer_binding_mismatch');
  });

  it('rejects on an invalid issuer_signature', async () => {
    const issuer = mlDsa44GenerateKeypair();
    const issuerAddress = keccak256(issuer.publicKey);
    const secureKeyProvider = makeFakeSecureKeyProvider('issuer-key', issuer);
    const rpc = makeHappyPathRpc(issuerAddress);
    const cardVerifier = createCardVerifier({ rpc, ipfs: fakeIpfs, appCertificationRoot: issuerAddress });

    const offer = await assembleAndSignTargetedOffer({
      secureKeyProvider,
      issuerSigningKeyId: 'issuer-key',
      policyId: 'policy-cid',
      issuerCard: issuerAddress,
      pressCard: PRESS_CARD,
      ancestryPubkeys: [issuer.publicKey],
      fieldValues: {},
    });
    const tampered = { ...offer, issuer_signature: bytesToBase64Url(new Uint8Array(2420)) };

    const result = await reviewTargetedOffer(tampered, { cardVerifier, rpc, policyAddress: POLICY_ADDRESS });
    expect(result.approved).toBe(false);
    if (result.approved) throw new Error('unreachable');
    expect(result.code).toBe('issuer_signature_invalid');
  });

  it('rejects when the issuer chain does not reach a trusted root', async () => {
    const issuer = mlDsa44GenerateKeypair();
    const issuerAddress = keccak256(issuer.publicKey);
    const secureKeyProvider = makeFakeSecureKeyProvider('issuer-key', issuer);
    // Registered card, but NOT a trusted root/policy authorizer.
    const rpc: RpcProvider = {
      getCardEntry: async (address) =>
        address === issuerAddress
          ? { log_head_cid: 'cid', policy_address: POLICY_ADDRESS, last_press_address: PRESS_CARD, forward_to: null, exists: true }
          : null,
      isPolicyAuthorizer: async () => false,
      getPressAuthorization: async () => ({ press_public_key: 'x', mldsa44_key_hash: 'y', active: true, authorized_at: '2026-01-01T00:00:00.000Z', revoked_at: null }),
      getSubCardEntry: async () => null,
      getLogEntries: async () => [],
      getEasAnnotations: async () => [],
    };
    const cardVerifier = createCardVerifier({ rpc, ipfs: fakeIpfs, appCertificationRoot: issuerAddress, trustedRoots: [] });

    const offer = await assembleAndSignTargetedOffer({
      secureKeyProvider,
      issuerSigningKeyId: 'issuer-key',
      policyId: 'policy-cid',
      issuerCard: issuerAddress,
      pressCard: PRESS_CARD,
      ancestryPubkeys: [issuer.publicKey],
      fieldValues: {},
    });

    const result = await reviewTargetedOffer(offer, { cardVerifier, rpc, policyAddress: POLICY_ADDRESS });
    expect(result.approved).toBe(false);
    if (result.approved) throw new Error('unreachable');
    expect(result.code).toBe('issuer_chain_not_trusted');
  });

  it('rejects when the named press is not on-chain authorized', async () => {
    const issuer = mlDsa44GenerateKeypair();
    const issuerAddress = keccak256(issuer.publicKey);
    const secureKeyProvider = makeFakeSecureKeyProvider('issuer-key', issuer);
    const rpc: RpcProvider = {
      getCardEntry: async (address) =>
        address === issuerAddress
          ? { log_head_cid: 'cid', policy_address: POLICY_ADDRESS, last_press_address: PRESS_CARD, forward_to: null, exists: true }
          : null,
      isPolicyAuthorizer: async (address) => address === issuerAddress,
      getPressAuthorization: async () => null, // not authorized
      getSubCardEntry: async () => null,
      getLogEntries: async () => [],
      getEasAnnotations: async () => [],
    };
    const cardVerifier = createCardVerifier({ rpc, ipfs: fakeIpfs, appCertificationRoot: issuerAddress, trustedRoots: [issuerAddress] });

    const offer = await assembleAndSignTargetedOffer({
      secureKeyProvider,
      issuerSigningKeyId: 'issuer-key',
      policyId: 'policy-cid',
      issuerCard: issuerAddress,
      pressCard: PRESS_CARD,
      ancestryPubkeys: [issuer.publicKey],
      fieldValues: {},
    });

    const result = await reviewTargetedOffer(offer, { cardVerifier, rpc, policyAddress: POLICY_ADDRESS });
    expect(result.approved).toBe(false);
    if (result.approved) throw new Error('unreachable');
    expect(result.code).toBe('press_not_authorized');
  });

  it('returns a rejection (not a throw) when CardVerifier itself errors — simulating a decryption failure', async () => {
    const issuer = mlDsa44GenerateKeypair();
    const issuerAddress = keccak256(issuer.publicKey);
    const secureKeyProvider = makeFakeSecureKeyProvider('issuer-key', issuer);
    const rpc = makeHappyPathRpc(issuerAddress);
    const cardVerifier = createCardVerifier({ rpc, ipfs: fakeIpfs, appCertificationRoot: issuerAddress, trustedRoots: [issuerAddress] });
    vi.spyOn(cardVerifier, 'verifyCard').mockRejectedValue(new Error('AES-GCM authentication failed'));

    const offer = await assembleAndSignTargetedOffer({
      secureKeyProvider,
      issuerSigningKeyId: 'issuer-key',
      policyId: 'policy-cid',
      issuerCard: issuerAddress,
      pressCard: PRESS_CARD,
      ancestryPubkeys: [issuer.publicKey],
      fieldValues: {},
    });

    const result = await reviewTargetedOffer(offer, { cardVerifier, rpc, policyAddress: POLICY_ADDRESS });
    expect(result.approved).toBe(false);
    if (result.approved) throw new Error('unreachable');
    expect(result.code).toBe('verification_error');
    expect(result.reason).toMatch(/AES-GCM authentication failed/);
  });

  it('surfaces an advisory warning (without rejecting) when the press is authorized on-chain but absent from approved_presses', async () => {
    const issuer = mlDsa44GenerateKeypair();
    const issuerAddress = keccak256(issuer.publicKey);
    const secureKeyProvider = makeFakeSecureKeyProvider('issuer-key', issuer);
    const rpc = makeHappyPathRpc(issuerAddress);
    const cardVerifier = createCardVerifier({ rpc, ipfs: fakeIpfs, appCertificationRoot: issuerAddress, trustedRoots: [issuerAddress] });

    const offer = await assembleAndSignTargetedOffer({
      secureKeyProvider,
      issuerSigningKeyId: 'issuer-key',
      policyId: 'policy-cid',
      issuerCard: issuerAddress,
      pressCard: PRESS_CARD,
      ancestryPubkeys: [issuer.publicKey],
      fieldValues: {},
    });

    const result = await reviewTargetedOffer(offer, {
      cardVerifier,
      rpc,
      policyAddress: POLICY_ADDRESS,
      policyApprovedPresses: ['some-other-press'],
    });
    expect(result.approved).toBe(true);
    if (!result.approved) throw new Error('unreachable');
    expect(result.pressAdvisoryWarning).toMatch(/approved_presses/);
  });
});

describe('reviewOpenOffer', () => {
  it('approves a fully valid open offer', async () => {
    const issuer = mlDsa44GenerateKeypair();
    const issuerAddress = keccak256(issuer.publicKey);
    const secureKeyProvider = makeFakeSecureKeyProvider('issuer-key', issuer);
    const rpc = makeHappyPathRpc(issuerAddress);
    const cardVerifier = createCardVerifier({ rpc, ipfs: fakeIpfs, appCertificationRoot: issuerAddress, trustedRoots: [issuerAddress] });

    const { offer } = await assembleAndSignOpenOffer({
      secureKeyProvider,
      issuerSigningKeyId: 'issuer-key',
      policyId: 'policy-cid',
      pressCard: PRESS_CARD,
      issuerCard: issuerAddress,
      issuerPubkey: issuer.publicKey,
      maxAcceptances: 10,
      proposedFields: {},
    });

    const result = await reviewOpenOffer(offer, { cardVerifier, rpc, policyAddress: POLICY_ADDRESS });
    expect(result.approved).toBe(true);
  });

  it('rejects on issuer_pubkey/issuer_card binding mismatch', async () => {
    const issuer = mlDsa44GenerateKeypair();
    const issuerAddress = keccak256(issuer.publicKey);
    const secureKeyProvider = makeFakeSecureKeyProvider('issuer-key', issuer);
    const rpc = makeHappyPathRpc(issuerAddress);
    const cardVerifier = createCardVerifier({ rpc, ipfs: fakeIpfs, appCertificationRoot: issuerAddress, trustedRoots: [issuerAddress] });

    const { offer } = await assembleAndSignOpenOffer({
      secureKeyProvider,
      issuerSigningKeyId: 'issuer-key',
      policyId: 'policy-cid',
      pressCard: PRESS_CARD,
      issuerCard: 'a-completely-different-card-pointer',
      issuerPubkey: issuer.publicKey,
      maxAcceptances: 10,
      proposedFields: {},
    });

    const result = await reviewOpenOffer(offer, { cardVerifier, rpc, policyAddress: POLICY_ADDRESS });
    expect(result.approved).toBe(false);
    if (result.approved) throw new Error('unreachable');
    expect(result.code).toBe('issuer_binding_mismatch');
  });

  it('rejects on an invalid issuer_signature', async () => {
    const issuer = mlDsa44GenerateKeypair();
    const issuerAddress = keccak256(issuer.publicKey);
    const secureKeyProvider = makeFakeSecureKeyProvider('issuer-key', issuer);
    const rpc = makeHappyPathRpc(issuerAddress);
    const cardVerifier = createCardVerifier({ rpc, ipfs: fakeIpfs, appCertificationRoot: issuerAddress, trustedRoots: [issuerAddress] });

    const { offer } = await assembleAndSignOpenOffer({
      secureKeyProvider,
      issuerSigningKeyId: 'issuer-key',
      policyId: 'policy-cid',
      pressCard: PRESS_CARD,
      issuerCard: issuerAddress,
      issuerPubkey: issuer.publicKey,
      maxAcceptances: 10,
      proposedFields: {},
    });
    const tampered = { ...offer, issuer_signature: bytesToBase64Url(new Uint8Array(2420)) };

    const result = await reviewOpenOffer(tampered, { cardVerifier, rpc, policyAddress: POLICY_ADDRESS });
    expect(result.approved).toBe(false);
    if (result.approved) throw new Error('unreachable');
    expect(result.code).toBe('issuer_signature_invalid');
  });

  it('rejects when the named press is not on-chain authorized', async () => {
    const issuer = mlDsa44GenerateKeypair();
    const issuerAddress = keccak256(issuer.publicKey);
    const secureKeyProvider = makeFakeSecureKeyProvider('issuer-key', issuer);
    const rpc: RpcProvider = {
      getCardEntry: async (address) =>
        address === issuerAddress
          ? { log_head_cid: 'cid', policy_address: POLICY_ADDRESS, last_press_address: PRESS_CARD, forward_to: null, exists: true }
          : null,
      isPolicyAuthorizer: async (address) => address === issuerAddress,
      getPressAuthorization: async () => ({ press_public_key: 'x', mldsa44_key_hash: 'y', active: false, authorized_at: '2026-01-01T00:00:00.000Z', revoked_at: '2026-02-01T00:00:00.000Z' }),
      getSubCardEntry: async () => null,
      getLogEntries: async () => [],
      getEasAnnotations: async () => [],
    };
    const cardVerifier = createCardVerifier({ rpc, ipfs: fakeIpfs, appCertificationRoot: issuerAddress, trustedRoots: [issuerAddress] });

    const { offer } = await assembleAndSignOpenOffer({
      secureKeyProvider,
      issuerSigningKeyId: 'issuer-key',
      policyId: 'policy-cid',
      pressCard: PRESS_CARD,
      issuerCard: issuerAddress,
      issuerPubkey: issuer.publicKey,
      maxAcceptances: 10,
      proposedFields: {},
    });

    const result = await reviewOpenOffer(offer, { cardVerifier, rpc, policyAddress: POLICY_ADDRESS });
    expect(result.approved).toBe(false);
    if (result.approved) throw new Error('unreachable');
    expect(result.code).toBe('press_not_authorized');
  });
});
