import { describe, it, expect, vi } from 'vitest';
import type { IpfsProvider, RpcProvider } from '@membership-card-protocol/verifier';
import { createCardVerifier } from '../../src/verification/CardVerifier.js';
import { requestSubCard } from '../../src/subcards/requestSubCard.js';
import { handleSubCardRequest } from '../../src/subcards/handleSubCardRequest.js';
import { assembleSubCardConsent } from '../../src/subcards/consent.js';
import { countersignSubCardRequest } from '../../src/subcards/countersign.js';
import { createPressSubCardRegistrar } from '../../src/subcards/pressSubmission.js';
import { revokeSubCard } from '../../src/subcards/revocation.js';
import { mlDsa44GenerateKeypair, mlDsa44Sign } from '../../src/crypto/mldsa.js';
import { keccak256 } from '../../src/crypto/hashes.js';
import { base64UrlToBytes } from '../../src/util/base64url.js';
import type { WalletAppCardIdentity } from '../../src/wallet/deviceSubCard.js';
import type { SecureKeyProvider } from '../../src/providers/SecureKeyProvider.js';
import type {
  ObliviousProtocolTransport,
  ObliviousDestination,
  RequestOptions,
  ObliviousResponse,
} from '../../src/providers/ObliviousProtocolTransport.js';

function jsonResponse(status: number, body: unknown): ObliviousResponse {
  return { status, headers: {}, body: new TextEncoder().encode(JSON.stringify(body)) };
}
function readJsonBody(options: RequestOptions): Record<string, unknown> {
  if (!options.body) return {};
  return JSON.parse(new TextDecoder().decode(options.body)) as Record<string, unknown>;
}

const GOVERNANCE_APP_CERT_ROOT = 'ff'.repeat(32);
const PRESS_BASE_URL = 'https://press.example';

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

/** A stub press + registry, tracking on-chain-ish state so a later revocation can be checked against what was registered. */
function makeStubPressAndRegistry(appCardAddress: string) {
  const state = {
    registeredSubCardDocs: [] as Record<string, unknown>[],
    revocations: [] as Record<string, unknown>[],
  };

  const transport: ObliviousProtocolTransport = {
    request: vi.fn(async (destination: ObliviousDestination, options: RequestOptions) => {
      expect(destination).toEqual({ kind: 'press', baseUrl: PRESS_BASE_URL });

      if (options.method === 'POST' && options.path === '/sub-card/register') {
        const body = readJsonBody(options);
        state.registeredSubCardDocs.push(body);
        return jsonResponse(200, { sub_card_doc_cid: 'sub-card-doc-cid-1', tx_hash: '0xregistertx' });
      }
      if (options.method === 'POST' && options.path === '/update') {
        const body = readJsonBody(options);
        state.revocations.push(body);
        return jsonResponse(200, { log_entry_cid: 'log-entry-cid-1', new_log_head_cid: 'new-log-head-cid-1' });
      }
      throw new Error(`stub press: unhandled ${options.method} ${options.path}`);
    }),
  };

  const rpc: RpcProvider = {
    getCardEntry: async (address) =>
      address === appCardAddress
        ? { log_head_cid: 'cid', policy_address: 'policy', last_press_address: 'press', forward_to: null, exists: true }
        : null,
    isPolicyAuthorizer: async (address) => address === appCardAddress,
    getPressAuthorization: async () => null,
    getSubCardEntry: async () => null,
    getLogEntries: async () => [],
    getEasAnnotations: async () => {
      throw new Error('getEasAnnotations should never be called — fetchAnnotations is false (OQ-SDK-11)');
    },
  };

  return { transport, rpc, state };
}

describe('Phase 4 end-to-end: request -> validate -> consent -> countersign -> register -> revoke', () => {
  it('completes the full loop against a stub press/registry, then revokes the registered sub-card', async () => {
    // --- Requester side (Step 4.1): a separate "SDK instance" (a
    // third-party app, not the wallet) requests a sub-card. ---
    const requesterSecureKeyProvider = makeFakeSecureKeyProvider();
    const appCard = makeFakeAppCard();
    const holder = mlDsa44GenerateKeypair();
    const holderPrimaryCard = keccak256(holder.publicKey);

    const { document: appSignedRequest } = await requestSubCard({
      secureKeyProvider: requesterSecureKeyProvider,
      subCardKeyId: 'app-sub-card-key',
      appCard,
      holderPrimaryCard,
      holderPrimaryCardPubkey: holder.publicKey,
      capabilities: ['auth_response', 'exchange_offer'],
      attestationLevel: 'T1',
    });

    // --- Wallet side: a distinct "SDK instance" acting as the wallet. ---
    const appCardAddress = keccak256(appCard.publicKey);
    const { transport, rpc, state } = makeStubPressAndRegistry(appCardAddress);
    const cardVerifier = createCardVerifier({
      rpc,
      ipfs: fakeIpfs,
      appCertificationRoot: GOVERNANCE_APP_CERT_ROOT,
      trustedRoots: [GOVERNANCE_APP_CERT_ROOT, appCardAddress],
      fetchAnnotations: false,
    });

    // Step 4.2: validate (signature, binding, certification chain, revocation log).
    const validated = await handleSubCardRequest({ cardVerifier, request: appSignedRequest });
    expect(validated.valid).toBe(true);
    if (!validated.valid) throw new Error('unreachable');

    // Step 4.3: consent data + countersign (host requests 2 capabilities;
    // wallet config grants both here, exercising the full-grant path — the
    // narrowing behavior itself is covered by consent.test.ts).
    const consent = assembleSubCardConsent({
      validated,
      appIdentity: { name: 'Example App', version: '2.1.0', publisher: 'Example Org' },
      walletGrantableCapabilities: ['auth_response', 'exchange_offer'],
    });
    expect(consent.grantableCapabilities).toEqual(['auth_response', 'exchange_offer']);

    const registerSubCard = createPressSubCardRegistrar({ transport, pressBaseUrl: PRESS_BASE_URL });
    const countersignOutcome = await countersignSubCardRequest({
      consentData: consent,
      decision: { approved: true, approvedCapabilities: consent.requestedCapabilities },
      masterSecretKey: holder.secretKey,
      registerSubCard,
    });
    expect(countersignOutcome.countersigned).toBe(true);
    if (!countersignOutcome.countersigned) throw new Error('unreachable');
    expect(countersignOutcome.registered).toBe(true);

    // Step 4.4: registered against the stub press.
    expect(state.registeredSubCardDocs).toHaveLength(1);
    expect(state.registeredSubCardDocs[0]).toEqual(countersignOutcome.document);

    const subCardAddress = keccak256(base64UrlToBytes(countersignOutcome.document.recipient_pubkey));

    // Now revoke it — user-initiated, signed by the wallet's own device
    // sub-card (a separate keypair from both the master and the requesting
    // app's sub-card).
    const deviceSubCard = mlDsa44GenerateKeypair();
    const revocation = await revokeSubCard({
      transport,
      pressBaseUrl: PRESS_BASE_URL,
      targetSubCard: subCardAddress,
      updater: { cardPointer: 'device-sub-card-pointer', sign: (m) => mlDsa44Sign(deviceSubCard.secretKey, m) },
      code: 801,
    });

    expect(revocation).toEqual({ logEntryCid: 'log-entry-cid-1', newLogHeadCid: 'new-log-head-cid-1' });
    expect(state.revocations).toHaveLength(1);
    expect((state.revocations[0]!.update_intent as Record<string, unknown>).target_card).toBe(subCardAddress);
    expect((state.revocations[0]!.update_intent as Record<string, unknown>).code).toBe(801);
  });
});
