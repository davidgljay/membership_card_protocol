import { describe, it, expect, vi } from 'vitest';
import {
  createCardVerifier,
  assembleAndSignOpenOffer,
  mlDsa44GenerateKeypair,
  mlDsa44Sign,
  mlDsa44Verify,
  canonicalize,
  keccak256,
} from '@membership-card-protocol/app-sdk';
import { bytesToBase64Url, base64UrlToBytes } from '@membership-card-protocol/app-sdk';
import { setupWallet } from '../../src/wallet/setupWallet.js';
import { acceptOpenOfferForExistingWallet } from '../../src/offers/existingWalletOpenOfferAcceptance.js';
import { decryptKeyring } from '../../src/wallet/keyring.js';
import { deriveDecryptionKey, passkeyOutputFromPrf } from '../../src/wallet/kdf.js';
import type {
  IpfsProvider,
  RpcProvider,
  WalletAppCardIdentity,
  RegisterSubCardFn,
  SignedSubCardDocument,
  PasskeyProvider,
  StorageProvider,
  SecureKeyProvider,
  ObliviousProtocolTransport,
  ObliviousDestination,
  RequestOptions,
  ObliviousResponse,
  CardVerifier,
} from '@membership-card-protocol/app-sdk';
import type { NotificationChannels } from '../../src/wallet/backupRegistration.js';

function jsonResponse(status: number, body: unknown): ObliviousResponse {
  return { status, headers: {}, body: new TextEncoder().encode(JSON.stringify(body)) };
}
function readJsonBody(options: RequestOptions): Record<string, unknown> {
  if (!options.body) return {};
  return JSON.parse(new TextDecoder().decode(options.body)) as Record<string, unknown>;
}

function makeFakeStorageProvider(): StorageProvider & { store: Map<string, Uint8Array> } {
  const store = new Map<string, Uint8Array>();
  return {
    store,
    get: vi.fn(async (key: string) => store.get(key)),
    set: vi.fn(async (key: string, value: Uint8Array) => {
      store.set(key, value);
    }),
    delete: vi.fn(async (key: string) => {
      store.delete(key);
    }),
  };
}

function makeFakeSecureKeyProvider(): SecureKeyProvider {
  const secretKeys = new Map<string, Uint8Array>();
  const publicKeys = new Map<string, Uint8Array>();
  return {
    generateKey: vi.fn(async (keyId: string) => {
      const keypair = mlDsa44GenerateKeypair();
      publicKeys.set(keyId, keypair.publicKey);
      secretKeys.set(keyId, keypair.secretKey);
      return keypair.publicKey;
    }),
    sign: vi.fn(async (keyId: string, message: Uint8Array) => {
      const secretKey = secretKeys.get(keyId);
      if (!secretKey) throw new Error('no key');
      return mlDsa44Sign(secretKey, message);
    }),
    getPublicKey: vi.fn(async (keyId: string) => publicKeys.get(keyId)),
    delete: vi.fn(),
  };
}

function makeFakeWalletAppCard(): WalletAppCardIdentity {
  const keypair = mlDsa44GenerateKeypair();
  return {
    cardPointer: keccak256(keypair.publicKey),
    publicKey: keypair.publicKey,
    sign: (message: Uint8Array) => mlDsa44Sign(keypair.secretKey, message),
  };
}

function makeFakeRegisterSubCard(): RegisterSubCardFn {
  return vi.fn(async (_doc: SignedSubCardDocument) => ({ registered: true }));
}

function makeFakePasskeyProvider(attestationObject: Uint8Array, credentialId: Uint8Array): PasskeyProvider {
  let registerCallCount = 0;
  return {
    register: vi.fn(async () => {
      registerCallCount += 1;
      if (registerCallCount === 1) {
        return { credentialId, attestationObject, clientDataJSON: new TextEncoder().encode('x'), prfOutput: attestationObject };
      }
      return {
        credentialId: new TextEncoder().encode(`synced-credential-${registerCallCount}`),
        attestationObject: new TextEncoder().encode(`synced-attestation-${registerCallCount}`),
        clientDataJSON: new TextEncoder().encode('x'),
        prfOutput: new TextEncoder().encode('synced-prf-output'),
      };
    }),
    assert: vi.fn(),
  };
}

const NOTIFICATION_CHANNELS: NotificationChannels = { email: 'holder@example.com' };
const CAPABILITIES = ['auth_response'];
const POLICY_ADDRESS = 'cc'.repeat(32);
const PRESS_CARD = 'dd'.repeat(32);
const PRESS_BASE_URL = 'https://press.example';
const GOVERNANCE_APP_CERT_ROOT = 'ff'.repeat(32);

const fakeIpfs: IpfsProvider = {
  fetch: async () => {
    throw new Error('not used — fetchAnnotations is false');
  },
};

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

function makeAlwaysTrustingCardVerifier(): CardVerifier {
  const rpc: RpcProvider = {
    getCardEntry: async () => ({ log_head_cid: 'cid', policy_address: 'policy', last_press_address: 'press', forward_to: null, exists: true }),
    isPolicyAuthorizer: async () => true,
    getPressAuthorization: async () => null,
    getSubCardEntry: async () => null,
    getLogEntries: async () => [],
    getEasAnnotations: async () => {
      throw new Error('getEasAnnotations should never be called');
    },
  };
  return createCardVerifier({
    rpc,
    ipfs: fakeIpfs,
    appCertificationRoot: GOVERNANCE_APP_CERT_ROOT,
    trustedRoots: [GOVERNANCE_APP_CERT_ROOT],
    fetchAnnotations: false,
  });
}

/** Stub wallet-service (for the setupWallet call) + press, sharing one transport. */
function makeCombinedTransport() {
  const state = {
    accounts: new Map<string, { keyringId: string; serviceSecret: Uint8Array }>(),
    keyringBlobsById: new Map<string, string>(),
    openOfferClaims: [] as Array<{ baseUrl: string; body: Record<string, unknown> }>,
    challengeCounter: 0,
  };
  const nextChallenge = () => {
    state.challengeCounter += 1;
    return bytesToBase64Url(new TextEncoder().encode(`challenge-${state.challengeCounter}`));
  };

  const transport: ObliviousProtocolTransport = {
    request: vi.fn(async (destination: ObliviousDestination, requestOptions: RequestOptions) => {
      const { method, path } = requestOptions;

      if (destination.kind === 'press') {
        if (method === 'POST' && path === '/open-offer/claim') {
          const body = readJsonBody(requestOptions);
          state.openOfferClaims.push({ baseUrl: destination.baseUrl, body });
          return jsonResponse(200, {
            card_cid: 'card-cid-existing-wallet',
            scip: {
              card_cid: 'card-cid-existing-wallet',
              policy_log_entry_index: 1,
              policy_log_root_at_inclusion: 'policy-log-root-cid',
              issued_at: new Date().toISOString(),
              press_signature: { public_key: 'press-pubkey', signature: 'press-sig' },
            },
          });
        }
        throw new Error(`stub press: unhandled ${method} ${path}`);
      }

      if (method === 'POST' && path === '/accounts/challenge') {
        return jsonResponse(200, { challenge: nextChallenge(), expires_at: new Date(Date.now() + 300_000).toISOString() });
      }
      if (method === 'POST' && path === '/accounts') {
        const body = readJsonBody(requestOptions);
        const cardHash = body.card_hash as string;
        const serviceSecret = crypto.getRandomValues(new Uint8Array(32));
        const keyringId = keccak256(base64UrlToBytes(body.encrypted_keyring_blob as string));
        state.keyringBlobsById.set(keyringId, body.encrypted_keyring_blob as string);
        state.accounts.set(cardHash, { keyringId, serviceSecret });
        return jsonResponse(200, {
          service_secret: bytesToBase64Url(serviceSecret),
          account_id: 'account-1',
          keyring_id: keyringId,
          session_token: 'session-token-1',
          expires_at: new Date(Date.now() + 900_000).toISOString(),
        });
      }
      const keyringChallengeMatch = path.match(/^\/accounts\/([^/]+)\/keyring\/challenge$/);
      if (method === 'POST' && keyringChallengeMatch) {
        return jsonResponse(200, { challenge: nextChallenge(), expires_at: new Date(Date.now() + 300_000).toISOString() });
      }
      const keyringUpdateMatch = path.match(/^\/accounts\/([^/]+)\/keyring$/);
      if (method === 'PUT' && keyringUpdateMatch) {
        const cardHash = keyringUpdateMatch[1]!;
        const body = readJsonBody(requestOptions);
        const newBlob = body.new_encrypted_keyring_blob as string;
        const newKeyringId = keccak256(base64UrlToBytes(newBlob));
        const rotate = body.rotate_service_secret !== false;
        const existing = state.accounts.get(cardHash);
        const serviceSecret = rotate ? crypto.getRandomValues(new Uint8Array(32)) : existing!.serviceSecret;
        state.keyringBlobsById.set(newKeyringId, newBlob);
        state.accounts.set(cardHash, { keyringId: newKeyringId, serviceSecret });
        return jsonResponse(200, { service_secret: bytesToBase64Url(serviceSecret), keyring_id: newKeyringId });
      }
      const backupsMatch = path.match(/^\/accounts\/([^/]+)\/backups$/);
      if (method === 'POST' && backupsMatch) {
        return jsonResponse(200, { backup_id: 'backup-1' });
      }

      throw new Error(`stub wallet service: unhandled ${method} ${path}`);
    }),
  };

  return { transport, state };
}

function makeIssuerSigner(issuer: { publicKey: Uint8Array; secretKey: Uint8Array }): SecureKeyProvider {
  return {
    generateKey: vi.fn(async () => issuer.publicKey),
    sign: vi.fn(async (_id: string, message: Uint8Array) => mlDsa44Sign(issuer.secretKey, message)),
    getPublicKey: vi.fn(async () => issuer.publicKey),
    delete: vi.fn(),
  };
}

describe('acceptOpenOfferForExistingWallet', () => {
  it('adds the new card to an existing wallet (from a real setupWallet call) without a new passkey or re-derived decryption_key', async () => {
    const { transport, state } = makeCombinedTransport();

    // --- Existing wallet state, from a real setupWallet call. ---
    const attestationObject = new TextEncoder().encode('existing-wallet-attestation');
    const credentialId = new TextEncoder().encode('existing-wallet-credential');
    const passkeyProvider = makeFakePasskeyProvider(attestationObject, credentialId);
    const storageProvider = makeFakeStorageProvider();
    const secureKeyProvider = makeFakeSecureKeyProvider();
    const walletAppCard = makeFakeWalletAppCard();
    const registerSubCard = makeFakeRegisterSubCard();
    const cardVerifier = makeAlwaysTrustingCardVerifier();

    const walletSetup = await setupWallet({
      passkeyProvider,
      storageProvider,
      transport,
      secureKeyProvider,
      walletAppCard,
      registerSubCard,
      cardVerifier,
      capabilities: CAPABILITIES,
      notificationChannels: NOTIFICATION_CHANNELS,
    });

    // Reconstruct decryption_key exactly as the holder's own client would
    // (via its own existing-credential unlock flow) — this SDK function
    // never derives it itself.
    const account = state.accounts.get(walletSetup.cardHash)!;
    const decryptionKey = deriveDecryptionKey(passkeyOutputFromPrf(attestationObject), account.serviceSecret);

    // --- Now accept an open offer into that SAME existing wallet. ---
    const issuer = mlDsa44GenerateKeypair();
    const issuerAddress = keccak256(issuer.publicKey);
    const { offer } = await assembleAndSignOpenOffer({
      secureKeyProvider: makeIssuerSigner(issuer),
      issuerSigningKeyId: 'issuer-key',
      policyId: 'policy-cid',
      pressCard: PRESS_CARD,
      issuerCard: issuerAddress,
      issuerPubkey: issuer.publicKey,
      maxAcceptances: 50,
      proposedFields: { tier: 'bronze' },
    });

    const rpc = makeHappyPathRpc(issuerAddress);
    const cardVerifierForReview = createCardVerifier({ rpc, ipfs: fakeIpfs, appCertificationRoot: issuerAddress, trustedRoots: [issuerAddress] });

    const registerSpyBeforeClaim = (passkeyProvider.register as ReturnType<typeof vi.fn>).mock.calls.length;

    const result = await acceptOpenOfferForExistingWallet({
      offer,
      chainVerification: { cardVerifier: cardVerifierForReview, rpc, policyAddress: POLICY_ADDRESS },
      pressBaseUrl: PRESS_BASE_URL,
      transport,
      storageProvider,
      decryptionKey,
    });

    // No new passkey was created by this call — passkeyProvider isn't even
    // part of this function's option surface, and register() call count is
    // unchanged from before the call.
    expect((passkeyProvider.register as ReturnType<typeof vi.fn>).mock.calls.length).toBe(registerSpyBeforeClaim);

    expect(result.approved).toBe(true);
    if (!result.approved) throw new Error('unreachable');
    expect(result.cardCid).toBe('card-cid-existing-wallet');

    // The claim reached the offer's press, signed by the new card key.
    expect(state.openOfferClaims).toHaveLength(1);
    const claimBody = state.openOfferClaims[0]!.body;
    const recipientSig = base64UrlToBytes(claimBody.recipient_signature as string);
    expect(mlDsa44Verify(result.newCardPublicKey, canonicalize(claimBody.claim_payload), recipientSig)).toBe(true);

    // The keyring now holds both the original master key and the new card's key.
    const finalAccount = state.accounts.get(walletSetup.cardHash)!;
    const finalDecryptionKey = deriveDecryptionKey(passkeyOutputFromPrf(attestationObject), finalAccount.serviceSecret);
    const finalBlob = storageProvider.store.get('keyring')!;
    const entries = decryptKeyring(finalBlob, finalDecryptionKey);
    expect(entries).toHaveLength(2);
    expect(entries[0]!.cardAddress).toBe(walletSetup.cardHash);
    expect(entries[1]!.cardAddress).toBe(keccak256(result.newCardPublicKey));
  });

  it('rejects the offer before touching the keyring or submitting any claim when verification fails', async () => {
    const { transport, state } = makeCombinedTransport();
    const storageProvider = makeFakeStorageProvider();
    // Seed a minimal existing keyring so a bug that skipped the rejection
    // check would still have something to (wrongly) write to.
    const decryptionKey = new Uint8Array(32).fill(9);

    const issuer = mlDsa44GenerateKeypair();
    const wrongIssuer = mlDsa44GenerateKeypair();
    const { offer } = await assembleAndSignOpenOffer({
      secureKeyProvider: makeIssuerSigner(issuer),
      issuerSigningKeyId: 'issuer-key',
      policyId: 'policy-cid',
      pressCard: PRESS_CARD,
      issuerCard: keccak256(wrongIssuer.publicKey),
      issuerPubkey: issuer.publicKey,
      maxAcceptances: 10,
      proposedFields: {},
    });

    const issuerAddress = keccak256(issuer.publicKey);
    const rpc = makeHappyPathRpc(issuerAddress);
    const cardVerifier = createCardVerifier({ rpc, ipfs: fakeIpfs, appCertificationRoot: issuerAddress, trustedRoots: [issuerAddress] });

    const result = await acceptOpenOfferForExistingWallet({
      offer,
      chainVerification: { cardVerifier, rpc, policyAddress: POLICY_ADDRESS },
      pressBaseUrl: PRESS_BASE_URL,
      transport,
      storageProvider,
      decryptionKey,
    });

    expect(result.approved).toBe(false);
    if (result.approved) throw new Error('unreachable');
    expect(result.code).toBe('issuer_binding_mismatch');
    expect(storageProvider.set).not.toHaveBeenCalled();
    expect(state.openOfferClaims).toHaveLength(0);
  });
});
