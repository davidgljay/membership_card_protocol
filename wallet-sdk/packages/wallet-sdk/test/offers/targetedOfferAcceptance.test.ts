import { describe, it, expect, vi } from 'vitest';
import {
  createCardVerifier,
  assembleAndSignTargetedOffer,
  forwardCountersignedTargetedOffer,
  mlDsa44GenerateKeypair,
  mlDsa44Sign,
  mlDsa44Verify,
  canonicalize,
  keccak256,
} from '@membership-card-protocol/app-sdk';
import { bytesToBase64Url, base64UrlToBytes } from '@membership-card-protocol/app-sdk';
import { acceptTargetedOffer } from '../../src/offers/targetedOfferAcceptance.js';
import { encryptKeyring, decryptKeyring } from '../../src/wallet/keyring.js';
import type {
  IpfsProvider,
  RpcProvider,
  StorageProvider,
  SecureKeyProvider,
  ObliviousProtocolTransport,
  ObliviousDestination,
  RequestOptions,
  ObliviousResponse,
} from '@membership-card-protocol/app-sdk';

function jsonResponse(status: number, body: unknown): ObliviousResponse {
  return { status, headers: {}, body: new TextEncoder().encode(JSON.stringify(body)) };
}
function readJsonBody(options: RequestOptions): Record<string, unknown> {
  if (!options.body) return {};
  return JSON.parse(new TextDecoder().decode(options.body)) as Record<string, unknown>;
}

function makeFakeStorageProvider(initialBlob: Uint8Array): StorageProvider & { store: Map<string, Uint8Array> } {
  const store = new Map<string, Uint8Array>();
  store.set('keyring', initialBlob);
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

function makeIssuerSigner(keypair: { publicKey: Uint8Array; secretKey: Uint8Array }): SecureKeyProvider {
  return {
    generateKey: vi.fn(async () => keypair.publicKey),
    sign: vi.fn(async (_id: string, message: Uint8Array) => mlDsa44Sign(keypair.secretKey, message)),
    getPublicKey: vi.fn(async () => keypair.publicKey),
    delete: vi.fn(),
  };
}

const POLICY_ADDRESS = 'cc'.repeat(32);
const PRESS_CARD = 'dd'.repeat(32);
const PRESS_BASE_URL = 'https://press.example';
const RECIPIENT_DECRYPTION_KEY = new Uint8Array(32).fill(11);
const RECIPIENT_MASTER_CARD_ADDRESS = 'ee'.repeat(32);

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

describe('targeted offer acceptance and press finalization', () => {
  it('end-to-end: offerer creates + forwards, recipient reviews + countersigns, press finalizes — completed card carries all three signatures, recipient holds the SCIP', async () => {
    const issuer = mlDsa44GenerateKeypair();
    const issuerAddress = keccak256(issuer.publicKey);
    const press = mlDsa44GenerateKeypair();

    // --- Offerer creates the offer (App SDK). ---
    const offer = await assembleAndSignTargetedOffer({
      secureKeyProvider: makeIssuerSigner(issuer),
      issuerSigningKeyId: 'issuer-key',
      policyId: 'policy-cid',
      issuerCard: issuerAddress,
      pressCard: PRESS_CARD,
      ancestryPubkeys: [issuer.publicKey],
      fieldValues: { tier: 'platinum' },
    });

    // --- Recipient reviews and countersigns (this package), against their
    // own existing keyring. ---
    const master = mlDsa44GenerateKeypair();
    const initialBlob = encryptKeyring(
      [{ cardAddress: RECIPIENT_MASTER_CARD_ADDRESS, privateKey: master.secretKey }],
      RECIPIENT_DECRYPTION_KEY
    );
    const storageProvider = makeFakeStorageProvider(initialBlob);
    const rpc = makeHappyPathRpc(issuerAddress);
    const cardVerifier = createCardVerifier({ rpc, ipfs: fakeIpfs, appCertificationRoot: issuerAddress, trustedRoots: [issuerAddress] });

    const acceptResult = await acceptTargetedOffer({
      offer,
      chainVerification: { cardVerifier, rpc, policyAddress: POLICY_ADDRESS },
      storageProvider,
      decryptionKey: RECIPIENT_DECRYPTION_KEY,
    });
    expect(acceptResult.approved).toBe(true);
    if (!acceptResult.approved) throw new Error('unreachable');

    // Recipient's keyring now holds the new card's key alongside the master.
    const recipientEntries = decryptKeyring(storageProvider.store.get('keyring')!, RECIPIENT_DECRYPTION_KEY);
    expect(recipientEntries).toHaveLength(2);
    expect(recipientEntries[1]!.cardAddress).toBe(keccak256(acceptResult.newCardPublicKey));

    // --- Offerer validates and forwards to the press (App SDK). ---
    const pressCalls: Array<{ destination: ObliviousDestination; body: Record<string, unknown> }> = [];
    const transport: ObliviousProtocolTransport = {
      request: vi.fn(async (destination: ObliviousDestination, requestOptions: RequestOptions) => {
        expect(destination).toEqual({ kind: 'press', baseUrl: PRESS_BASE_URL });
        expect(requestOptions.path).toBe('/issue/finalize');
        const body = readJsonBody(requestOptions);
        pressCalls.push({ destination, body });

        // Simulate the press: sign the complete document (the submitted
        // card has no press_signature field yet) with the press key.
        const pressSignature = mlDsa44Sign(press.secretKey, canonicalize(body));

        return jsonResponse(200, {
          card_cid: 'card-cid-targeted-123',
          scip: {
            card_cid: 'card-cid-targeted-123',
            policy_log_entry_index: 1,
            policy_log_root_at_inclusion: 'policy-log-root-cid',
            issued_at: new Date().toISOString(),
            press_signature: { public_key: bytesToBase64Url(press.publicKey), signature: bytesToBase64Url(pressSignature) },
          },
        });
      }),
    };

    const forwardResult = await forwardCountersignedTargetedOffer({
      originalOffer: offer,
      countersignedOffer: acceptResult.countersignedOffer,
      transport,
      pressBaseUrl: PRESS_BASE_URL,
    });

    expect(forwardResult.forwarded).toBe(true);
    if (!forwardResult.forwarded) throw new Error('unreachable');
    expect(forwardResult.cardCid).toBe('card-cid-targeted-123');

    // The press only ever saw the destination-parameterized oblivious
    // transport — never a direct fetch — for the finalization call.
    expect(pressCalls).toHaveLength(1);

    // The completed card (what the offerer actually submitted, now with a
    // press_signature) carries all three verifiable signatures.
    const submittedCard = pressCalls[0]!.body;
    const { issuer_signature, holder_signature, recipient_pubkey, ...offerFieldsOnly } = submittedCard as Record<
      string,
      unknown
    > & { issuer_signature: string; holder_signature: string; recipient_pubkey: string };

    // issuer_signature: over the original offer fields (excludes recipient_pubkey/holder_signature).
    expect(mlDsa44Verify(issuer.publicKey, canonicalize(offerFieldsOnly), base64UrlToBytes(issuer_signature))).toBe(true);

    // holder_signature: over offer fields (including issuer_signature) + recipient_pubkey.
    const withRecipient = { ...offerFieldsOnly, issuer_signature, recipient_pubkey };
    expect(
      mlDsa44Verify(acceptResult.newCardPublicKey, canonicalize(withRecipient), base64UrlToBytes(holder_signature))
    ).toBe(true);

    // press_signature (from the SCIP, in this simulated press): over the
    // complete countersigned document minus press_signature itself.
    const pressSigEntry = forwardResult.scip.press_signature;
    expect(
      mlDsa44Verify(base64UrlToBytes(pressSigEntry.public_key), canonicalize(submittedCard), base64UrlToBytes(pressSigEntry.signature))
    ).toBe(true);

    // The recipient holds the SCIP (returned here for out-of-band delivery
    // back to them, same as the countersigned offer traveled the other way).
    expect(forwardResult.scip.card_cid).toBe('card-cid-targeted-123');
  });

  it('refuses to forward when holder_signature does not verify, without ever calling the press', async () => {
    const issuer = mlDsa44GenerateKeypair();
    const issuerAddress = keccak256(issuer.publicKey);
    const offer = await assembleAndSignTargetedOffer({
      secureKeyProvider: makeIssuerSigner(issuer),
      issuerSigningKeyId: 'issuer-key',
      policyId: 'policy-cid',
      issuerCard: issuerAddress,
      pressCard: PRESS_CARD,
      ancestryPubkeys: [issuer.publicKey],
      fieldValues: {},
    });

    const forgedRecipient = mlDsa44GenerateKeypair();
    const transport: ObliviousProtocolTransport = { request: vi.fn() };

    const result = await forwardCountersignedTargetedOffer({
      originalOffer: offer,
      countersignedOffer: {
        recipient_pubkey: bytesToBase64Url(forgedRecipient.publicKey),
        // Signature produced over the WRONG payload (missing recipient_pubkey) — won't verify.
        holder_signature: bytesToBase64Url(mlDsa44Sign(forgedRecipient.secretKey, canonicalize(offer))),
      },
      transport,
      pressBaseUrl: PRESS_BASE_URL,
    });

    expect(result.forwarded).toBe(false);
    if (result.forwarded) throw new Error('unreachable');
    expect(result.reason).toMatch(/holder_signature/);
    expect(transport.request).not.toHaveBeenCalled();
  });

  it('rejects offer review before any countersignature is attempted (recipient side)', async () => {
    const issuer = mlDsa44GenerateKeypair();
    const wrongIssuer = mlDsa44GenerateKeypair();
    const offer = await assembleAndSignTargetedOffer({
      secureKeyProvider: makeIssuerSigner(issuer),
      issuerSigningKeyId: 'issuer-key',
      policyId: 'policy-cid',
      issuerCard: keccak256(wrongIssuer.publicKey), // binding mismatch
      pressCard: PRESS_CARD,
      ancestryPubkeys: [issuer.publicKey],
      fieldValues: {},
    });

    const issuerAddress = keccak256(issuer.publicKey);
    const rpc = makeHappyPathRpc(issuerAddress);
    const cardVerifier = createCardVerifier({ rpc, ipfs: fakeIpfs, appCertificationRoot: issuerAddress, trustedRoots: [issuerAddress] });
    const master = mlDsa44GenerateKeypair();
    const initialBlob = encryptKeyring(
      [{ cardAddress: RECIPIENT_MASTER_CARD_ADDRESS, privateKey: master.secretKey }],
      RECIPIENT_DECRYPTION_KEY
    );
    const storageProvider = makeFakeStorageProvider(initialBlob);

    const result = await acceptTargetedOffer({
      offer,
      chainVerification: { cardVerifier, rpc, policyAddress: POLICY_ADDRESS },
      storageProvider,
      decryptionKey: RECIPIENT_DECRYPTION_KEY,
    });

    expect(result.approved).toBe(false);
    if (result.approved) throw new Error('unreachable');
    expect(result.code).toBe('issuer_binding_mismatch');
    // The keyring was never touched.
    expect(decryptKeyring(storageProvider.store.get('keyring')!, RECIPIENT_DECRYPTION_KEY)).toHaveLength(1);
  });
});
