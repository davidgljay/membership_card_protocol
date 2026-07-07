import { describe, it, expect, vi } from 'vitest';
import {
  createCardVerifier,
  requestSubCard,
  mlDsa44GenerateKeypair,
  mlDsa44Sign,
  mlDsa44Verify,
  canonicalize,
  keccak256,
} from '@membership-card-protocol/app-sdk';
import { base64UrlToBytes } from '@membership-card-protocol/app-sdk';
import type {
  IpfsProvider,
  RpcProvider,
  WalletAppCardIdentity,
  SecureKeyProvider,
  SignedSubCardDocument,
} from '@membership-card-protocol/app-sdk';
import { handleSubCardRequest } from '../../src/subcards/handleSubCardRequest.js';
import { assembleSubCardConsent, type SubCardConsentData } from '../../src/subcards/consent.js';
import { countersignSubCardRequest } from '../../src/subcards/countersign.js';
import { registerDeviceSubCard } from '../../src/wallet/deviceSubCard.js';

const GOVERNANCE_APP_CERT_ROOT = 'ff'.repeat(32);

const fakeIpfs: IpfsProvider = {
  fetch: async () => {
    throw new Error('not used — fetchAnnotations is false');
  },
};

function makeFakeSecureKeyProvider(): SecureKeyProvider & { keys: Map<string, Uint8Array> } {
  const keys = new Map<string, Uint8Array>();
  const secretKeys = new Map<string, Uint8Array>();
  return {
    keys,
    generateKey: vi.fn(async (keyId: string) => {
      const keypair = mlDsa44GenerateKeypair();
      keys.set(keyId, keypair.publicKey);
      secretKeys.set(keyId, keypair.secretKey);
      return keypair.publicKey;
    }),
    sign: vi.fn(async (keyId: string, message: Uint8Array) => {
      const secretKey = secretKeys.get(keyId);
      if (!secretKey) throw new Error('no key');
      return mlDsa44Sign(secretKey, message);
    }),
    getPublicKey: vi.fn(async (keyId: string) => keys.get(keyId)),
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

async function makeConsent(capabilities: string[], grantable: string[]): Promise<{ consent: SubCardConsentData; holder: ReturnType<typeof mlDsa44GenerateKeypair>; appCard: WalletAppCardIdentity }> {
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
  if (!validated.valid) throw new Error('fixture setup failed');

  const consent = assembleSubCardConsent({
    validated,
    appIdentity: { name: 'Example App' },
    walletGrantableCapabilities: grantable,
  });

  return { consent, holder, appCard };
}

describe('countersignSubCardRequest', () => {
  it('produces a fully verifiable SignedSubCardDocument when approvedCapabilities exactly matches requested', async () => {
    const { consent, holder, appCard } = await makeConsent(['auth_response'], ['auth_response']);
    const registerSubCard = vi.fn(async (_doc: SignedSubCardDocument) => ({ registered: true }));

    const outcome = await countersignSubCardRequest({
      consentData: consent,
      decision: { approved: true, approvedCapabilities: ['auth_response'] },
      masterSecretKey: holder.secretKey,
      registerSubCard,
    });

    expect(outcome.countersigned).toBe(true);
    if (!outcome.countersigned) throw new Error('unreachable');
    expect(outcome.registered).toBe(true);
    expect(registerSubCard).toHaveBeenCalledWith(outcome.document);

    const doc = outcome.document;
    const { app_signature, holder_signature, ...withoutSignatures } = doc;
    expect(mlDsa44Verify(appCard.publicKey, canonicalize(withoutSignatures), base64UrlToBytes(app_signature))).toBe(true);
    const withAppSig = { ...withoutSignatures, app_signature };
    expect(mlDsa44Verify(holder.publicKey, canonicalize(withAppSig), base64UrlToBytes(holder_signature))).toBe(true);
  });

  it('refuses to countersign (and never calls registerSubCard) when approvedCapabilities is a strict subset of requested', async () => {
    const { consent, holder } = await makeConsent(['auth_response', 'exchange_offer'], ['auth_response']);
    const registerSubCard = vi.fn(async () => ({ registered: true }));

    const outcome = await countersignSubCardRequest({
      consentData: consent,
      decision: { approved: true, approvedCapabilities: consent.grantableCapabilities }, // narrower than requested
      masterSecretKey: holder.secretKey,
      registerSubCard,
    });

    expect(outcome.countersigned).toBe(false);
    if (outcome.countersigned) throw new Error('unreachable');
    expect(outcome.reason).toMatch(/exactly match/);
    expect(registerSubCard).not.toHaveBeenCalled();
  });

  it('refuses to countersign when the consent decision was not approved', async () => {
    const { consent, holder } = await makeConsent(['auth_response'], ['auth_response']);
    const registerSubCard = vi.fn(async () => ({ registered: true }));

    const outcome = await countersignSubCardRequest({
      consentData: consent,
      decision: { approved: false, approvedCapabilities: [] },
      masterSecretKey: holder.secretKey,
      registerSubCard,
    });

    expect(outcome.countersigned).toBe(false);
    if (outcome.countersigned) throw new Error('unreachable');
    expect(registerSubCard).not.toHaveBeenCalled();
  });
});

describe('self-signing exception (device sub-card collapse)', () => {
  it("registers the wallet's own device sub-card by going through the ordinary request/validate/consent/countersign pipeline, self-authorized", async () => {
    const secureKeyProvider = makeFakeSecureKeyProvider();
    const walletAppCard = makeFakeAppCard(); // stands in for the wallet's own app card
    const master = mlDsa44GenerateKeypair();
    const registerSubCard = vi.fn(async (_doc: SignedSubCardDocument) => ({ registered: true }));

    const walletAppCardAddress = keccak256(walletAppCard.publicKey);
    const cardVerifier = createCardVerifier({
      rpc: makeHappyPathRpc(walletAppCardAddress),
      ipfs: fakeIpfs,
      appCertificationRoot: GOVERNANCE_APP_CERT_ROOT,
      trustedRoots: [GOVERNANCE_APP_CERT_ROOT, walletAppCardAddress],
    });

    const result = await registerDeviceSubCard({
      secureKeyProvider,
      cardHash: keccak256(master.publicKey),
      masterPublicKey: master.publicKey,
      masterSecretKey: master.secretKey,
      walletAppCard,
      registerSubCard,
      cardVerifier,
      capabilities: ['auth_response'],
    });

    expect(result.registered).toBe(true);
    expect(registerSubCard).toHaveBeenCalledTimes(1);
    expect(result.document.holder_signature).toBeTruthy();

    // Both signatures verify — the pipeline went through the ordinary
    // app_signature/holder_signature construction, not a hand-assembled
    // shortcut.
    const { app_signature, holder_signature, ...withoutSignatures } = result.document;
    expect(
      mlDsa44Verify(walletAppCard.publicKey, canonicalize(withoutSignatures), base64UrlToBytes(app_signature))
    ).toBe(true);
    const withAppSig = { ...withoutSignatures, app_signature };
    expect(mlDsa44Verify(master.publicKey, canonicalize(withAppSig), base64UrlToBytes(holder_signature))).toBe(true);
  });
});
