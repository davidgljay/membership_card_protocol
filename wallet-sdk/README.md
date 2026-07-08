# Card Protocol — Wallet SDK

`@membership-card-protocol/wallet-sdk` is the SDK for building wallet applications that hold card holder's private keys and manage key custody for the Card Protocol.

## Overview

This package provides everything a wallet integrator needs:

- **Wallet setup** — initialize a new wallet with a master key, keyring, and backup registrations
- **Backup and recovery** — passkey/YubiKey wrapped backup and full wallet recovery flows
- **Sub-card authorization** — validate third-party app requests for sub-cards and sign authorization grants
- **Card offer acceptance** — review, verify, and countersign received card offers
- **Sub-card lifecycle** — revoke and deregister sub-cards, maintain the active sub-cards directory

This package imports and builds on [`@membership-card-protocol/app-sdk`](../app-sdk/packages/app-sdk) for all non-custody operations (offer construction, messaging, relay lifecycle, verification). You do **not** need to install `app-sdk` separately — it comes as a transitive dependency of `wallet-sdk`.

## Integrating Wallet SDK

### Provider Interfaces

Wallet SDK uses all six provider interfaces from App SDK. See the [App SDK README](../app-sdk/README.md#provider-interfaces) for a complete description of each. The same injected-provider pattern applies here: you supply implementations appropriate to your platform.

Default implementations are shipped in:
- [`@membership-card-protocol/sdk-providers-web`](../sdk-providers-web/packages/sdk-providers-web) — WebCrypto, IndexedDB, WebAuthn, EventSource/WebSocket
- [`@membership-card-protocol/sdk-providers-rn`](../sdk-providers-rn/packages/sdk-providers-rn) — React Native Keychain, AsyncStorage, react-native-passkey, SSE

If you're building a web app, do:

```ts
import * as WalletSDK from '@membership-card-protocol/wallet-sdk';
import {
  WebCryptoSecureKeyProvider,
  IndexedDBStorageProvider,
  WebAuthnPasskeyProvider,
  WebRealtimeTransportProvider,
} from '@membership-card-protocol/sdk-providers-web';

const wallet = {
  secureKeyProvider: new WebCryptoSecureKeyProvider(),
  storageProvider: new IndexedDBStorageProvider({ name: 'myapp-wallet' }),
  passkeyProvider: new WebAuthnPasskeyProvider(),
  realtimeTransportProvider: new WebRealtimeTransportProvider(),
};
```

For React Native, replace `sdk-providers-web` with `@membership-card-protocol/sdk-providers-rn` and instantiate the RN-specific providers instead.

### Master Key Custody Invariants

**Critical:** Understand these invariants before integrating:

1. **The master private key never leaves `setupWallet`/`recoverWallet`** — once setup is complete, there is no general "unlock the wallet" primitive that re-derives or returns the master key. The wallet-holder must re-derive it through their own authentication flow (asserting their passkey, fetching the current service secret from the service endpoint) whenever it's needed, and keep it scoped to the minimal function call that requires it.

2. **Per-card acceptance keys are "persist before sign"** — when a wallet accepts a new card offer, a fresh keypair is generated, the keyring is updated and persisted to storage first, and only then is the acceptance signed. If the wallet crashes between these two steps, the keypair exists (recoverable from the keyring); it's never left in a signed-but-unpersisted state.

3. **The master key is cleared after use** — all functions that handle the master key clear it in a `finally` block. The wallet integrator is responsible for keeping the decryption key scoped and cleared as well.

4. **Sub-card keys are hardware-backed** — device sub-cards use the same non-exportable hardware-backed storage (`SecureKeyProvider`) as offer construction; they cannot be extracted or compromised via the SDK's interface.

See [`specs/object_specs/wallet_sdk.md` §10](../specs/object_specs/wallet_sdk.md#10-security-invariants) for the full formal statement of these invariants.

## Worked Example: Setup and Recovery

```ts
import * as WalletSDK from '@membership-card-protocol/wallet-sdk';
import { CardVerifier } from '@membership-card-protocol/app-sdk';
import { RpcProvider, IpfsProvider } from '@membership-card-protocol/app-sdk';

// 1. Initialize providers (see "Integrating Wallet SDK" above)
const providers = {
  secureKeyProvider: new WebCryptoSecureKeyProvider(),
  storageProvider: new IndexedDBStorageProvider({ name: 'myapp-wallet' }),
  passkeyProvider: new WebAuthnPasskeyProvider(),
  realtimeTransportProvider: new WebRealtimeTransportProvider(),
};

// 2. Create a CardVerifier (reuse this instance everywhere)
const verifier = createCardVerifier({
  rpc: yourRpcProvider,
  ipfs: yourIpfsProvider,
  appCertificationRoot: 'governance-root',
  trustedRoots: ['governance-root'],
});

// 3. Set up a new wallet
const setupResult = await WalletSDK.setupWallet({
  ...providers,
  cardVerifier: verifier,
  transport, // ObliviousProtocolTransport
  walletServiceBaseUrl: 'https://wallet.example',
  pressBaseUrl: 'https://press.example',
  relayBaseUrl: 'https://relay.example',
  deviceName: 'My iPhone',
  capabilities: ['send-mail', 'receive-mail'],
});

console.log('Master card:', setupResult.masterCardHash);
console.log('Keyring ID:', setupResult.keyringId);
console.log('Device sub-card:', setupResult.deviceSubCard.subCardPublicKey);

// Later, if the device is lost:
// 1. Initiate recovery on another device (similar setup flow, but different flow variant)
const recoveryResult = await WalletSDK.recoverWallet({
  ...providers,
  cardVerifier: verifier,
  transport,
  cardHash: setupResult.masterCardHash,
  backupId: setupResult.backupId,
  walletServiceBaseUrl: 'https://wallet.example',
  pressBaseUrl: 'https://press.example',
  relayBaseUrl: 'https://relay.example',
});

console.log('Wallet recovered. New keyring ID:', recoveryResult.keyringId);
```

## Accepting a Card Offer

```ts
import * as WalletSDK from '@membership-card-protocol/wallet-sdk';

// Review and accept a targeted offer
const approvedOffer = await WalletSDK.reviewTargetedOffer(
  offer,
  chainVerification, // chain/press verification options
);

if (!approvedOffer.approved) {
  console.error('Offer rejected:', approvedOffer.reason);
  return;
}

// Counter-sign and finalize
const result = await WalletSDK.acceptTargetedOffer({
  approvedOffer,
  decryptionKey, // obtained from your auth flow
  masterPublicKey,
  holderCardHash,
  secureKeyProvider,
  storageProvider,
  issuerCardVerification,
});

console.log('Card accepted. New card public key:', result.countersignedOffer);
```

## Sub-Card Authorization

```ts
// An app is requesting a sub-card for itself
const validated = await WalletSDK.handleSubCardRequest({
  cardVerifier: verifier,
  request: appRequest,
});

if (!validated.valid) {
  console.error('Request invalid:', validated.reason);
  return;
}

// Display consent screen to user
const consentData = WalletSDK.assembleSubCardConsent({
  validated,
  appIdentity: { name: 'My App' },
  walletGrantableCapabilities: ['send-mail', 'receive-mail'],
});

// User approves
const approved = {
  approved: true,
  approvedCapabilities: consentData.requestedCapabilities, // must match exactly
};

// Countersign and register
const result = await WalletSDK.countersignSubCardRequest({
  consentData,
  decision: approved,
  masterSecretKey,
  registerSubCard, // submission function
});

if (result.countersigned) {
  console.log('Sub-card registered:', result.document);
}
```

## Specification

See [`specs/object_specs/wallet_sdk.md`](../specs/object_specs/wallet_sdk.md) for the complete specification, including all exported functions, types, security invariants, and design decisions.

## Development

```sh
cd wallet-sdk/packages/wallet-sdk
pnpm install
pnpm typecheck
pnpm test
pnpm build
pnpm lint
```
