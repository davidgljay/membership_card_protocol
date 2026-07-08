// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { webcrypto } from 'crypto';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { setupWallet } from '../../src/wallet/setupWallet.js';
import {
  mlDsa44GenerateKeypair,
  mlDsa44Sign,
  keccak256,
  createCardVerifier,
} from '@membership-card-protocol/app-sdk';
import { bytesToBase64Url } from '@membership-card-protocol/app-sdk';
import type {
  WalletAppCardIdentity,
  RegisterSubCardFn,
  ObliviousProtocolTransport,
  ObliviousResponse,
  RequestOptions,
  IpfsProvider,
  RpcProvider,
  SignedSubCardDocument,
} from '@membership-card-protocol/app-sdk';
import {
  WebCryptoSecureKeyProvider,
  IndexedDBStorageProvider,
  WebAuthnPasskeyProvider,
} from '@membership-card-protocol/sdk-providers-web';

/**
 * Cross-platform scenario test (Step 3.2c): `setupWallet` driven as far as
 * possible against *real* `WebCryptoSecureKeyProvider` +
 * `IndexedDBStorageProvider` + `WebAuthnPasskeyProvider` from
 * `sdk-providers-web`, with `navigator.credentials` mocked at the same
 * boundary `sdk-providers-web`'s own `test/providers/PasskeyProvider.test.ts`
 * mocks it (jsdom implements no WebAuthn at all, confirmed by that file's own
 * doc comment — this is not a wallet-sdk-specific limitation).
 *
 * **Named, confirmed blocker (not a test-environment workaround target):**
 * `WebAuthnPasskeyProvider.register()` (`sdk-providers-web/src/
 * PasskeyProvider.ts`) never calls `credential.getClientExtensionResults()`
 * — it returns only `{ credentialId, attestationObject, clientDataJSON }`,
 * with no `prfOutput` field at all, regardless of what the mocked
 * `navigator.credentials.create()` call resolves to (mocking the
 * WebAuthn ceremony's response cannot inject a field the provider's own
 * code never reads off the credential). `setupWallet` (`wallet/
 * setupWallet.ts` line ~200) requires `registration.prfOutput` to be
 * truthy immediately after the device-bound passkey `register()` call, and
 * throws a specific, named error if it's absent — this is a real gap in
 * `sdk-providers-web`'s current `WebAuthnPasskeyProvider` implementation
 * (missing WebAuthn PRF extension support), not a jsdom/environment
 * limitation and not something a differently-shaped mock could route
 * around. Fixing it means adding `getClientExtensionResults()` handling to
 * `WebAuthnPasskeyProvider` itself, in `sdk-providers-web` — out of scope
 * for wallet-sdk to modify.
 *
 * This test proves everything *before* that point runs against real
 * providers — real WebCrypto key wrapping, real IndexedDB storage, a real
 * `WebAuthnPasskeyProvider` instance driving an (mocked-at-the-navigator-
 * boundary-only) WebAuthn ceremony, and a real `/accounts/challenge`
 * round trip through `setupWallet`'s own request-construction logic — and
 * then pins the exact, real failure mode as a regression-guarded,
 * documented blocker, rather than silently working around it with a fully
 * fake `PasskeyProvider` (which is what `test/wallet/setupWallet.test.ts`'s
 * existing unit tests already do, and is not what this scenario file is
 * for).
 */

if (!globalThis.crypto.subtle) {
  Object.defineProperty(globalThis.crypto, 'subtle', {
    value: webcrypto.subtle,
    writable: false,
    configurable: false,
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(status: number, body: unknown): ObliviousResponse {
  return { status, headers: {}, body: new TextEncoder().encode(JSON.stringify(body)) };
}

function makeWalletAppCard(): WalletAppCardIdentity {
  const keypair = mlDsa44GenerateKeypair();
  return {
    cardPointer: keccak256(keypair.publicKey),
    publicKey: keypair.publicKey,
    sign: (message: Uint8Array) => mlDsa44Sign(keypair.secretKey, message),
  };
}

function makeAlwaysTrustingCardVerifier(walletAppCardAddress: string) {
  const fakeIpfs: IpfsProvider = {
    fetch: async () => {
      throw new Error('not used — fetchAnnotations is false');
    },
  };
  const rpc: RpcProvider = {
    getCardEntry: async (address) =>
      address === walletAppCardAddress
        ? { log_head_cid: 'cid', policy_address: 'policy', last_press_address: 'press', forward_to: null, exists: true }
        : null,
    isPolicyAuthorizer: async (address) => address === walletAppCardAddress,
    getPressAuthorization: async () => null,
    getSubCardEntry: async () => null,
    getLogEntries: async () => [],
    getEasAnnotations: async () => [],
  };
  return createCardVerifier({
    rpc,
    ipfs: fakeIpfs,
    appCertificationRoot: 'ff'.repeat(32),
    trustedRoots: ['ff'.repeat(32), walletAppCardAddress],
  });
}

describe('setupWallet against real web providers (Step 3.2c)', () => {
  it('drives real WebCryptoSecureKeyProvider, IndexedDBStorageProvider, and WebAuthnPasskeyProvider up to the documented WebAuthn-PRF gap', async () => {
    // Mock navigator.credentials exactly as sdk-providers-web's own
    // PasskeyProvider.test.ts does — this is the only WebAuthn-layer mock
    // in this test; everything else (WebCrypto, IndexedDB, the provider
    // classes themselves) is real.
    const rawId = new Uint8Array([9, 9, 9]).buffer;
    const attestationObject = new Uint8Array([4, 5, 6]).buffer;
    const clientDataJSON = new Uint8Array([7, 8, 9]).buffer;
    const create = vi.fn().mockResolvedValue({
      rawId,
      response: { attestationObject, clientDataJSON },
      // A real authenticator's credential would expose
      // getClientExtensionResults() here; WebAuthnPasskeyProvider never
      // calls it (see this file's doc comment), so its presence or
      // absence in this mock cannot change the outcome — included only
      // for realism.
      getClientExtensionResults: () => ({ prf: { results: { first: new Uint8Array(32).buffer } } }),
    });
    vi.stubGlobal('navigator', { ...globalThis.navigator, credentials: { create } });

    const secureKeyProvider = new WebCryptoSecureKeyProvider();
    const storageProvider = new IndexedDBStorageProvider('scenario-setup-wallet');
    const passkeyProvider = new WebAuthnPasskeyProvider({ rpId: 'example.com', rpName: 'Scenario Wallet' });

    const walletAppCard = makeWalletAppCard();
    const walletAppCardAddress = keccak256(walletAppCard.publicKey);
    const cardVerifier = makeAlwaysTrustingCardVerifier(walletAppCardAddress);
    const registerSubCard: RegisterSubCardFn = vi.fn(async (_doc: SignedSubCardDocument) => ({ registered: true }));

    const calls: Array<{ path: string; options: RequestOptions }> = [];
    const transport: ObliviousProtocolTransport = {
      request: vi.fn(async (_destination, options) => {
        calls.push({ path: options.path ?? '', options });
        if (options.path === '/accounts/challenge') {
          return jsonResponse(200, { challenge: bytesToBase64Url(new Uint8Array(16).fill(1)), expires_at: '2099-01-01T00:00:00Z' });
        }
        throw new Error(`unexpected request in this scenario: ${options.method} ${options.path}`);
      }),
    };

    // Everything through the real /accounts/challenge round trip and the
    // real WebAuthnPasskeyProvider.register() call succeeds — this is the
    // real-provider surface this scenario proves. The function then
    // throws at the documented, named PRF gap.
    await expect(
      setupWallet({
        passkeyProvider,
        storageProvider,
        transport,
        secureKeyProvider,
        walletAppCard,
        registerSubCard,
        cardVerifier,
        capabilities: ['auth_response'],
        notificationChannels: { email: 'holder@example.com' },
      })
    ).rejects.toThrow(/did not return a PRF output/);

    // Confirm the real /accounts/challenge call actually happened before
    // the throw — i.e., this genuinely exercised the transport and
    // passkey provider, not a mock that short-circuited immediately.
    expect(calls.map((c) => c.path)).toEqual(['/accounts/challenge']);
    expect(create).toHaveBeenCalledTimes(1);
  });
});
