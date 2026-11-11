# Card Protocol — App SDK

`@membership-card-protocol/app-sdk` is the library a third-party application, integrator (press, wallet-service, relay), or web frontend links against to perform on-device functions the protocol assigns to roles that do not custody private keys.

**What this SDK does:**
- Construct and sign card offers (targeted and open)
- Handle sub-card requests from wallet apps (the app side of sub-card delegation)
- Sign arbitrary data with a sub-card (proving ownership without a full flow)
- Build, encrypt, and fan-out messages to recipients' registered sub-cards
- Decrypt and verify inbound messages, with per-device routing
- Manage UUIDs, relay sessions, and realtime delivery (SSE, WebSocket, polling)
- All with zero custody of any private key or backup material

**What this SDK does NOT do:**
- Custody the card holder's master key or backup material (see `@membership-card-protocol/wallet-sdk` for that)
- Run wallet setup, backup, or recovery flows
- Perform wallet-service, press, or relay endpoint logic (this SDK provides the client-side half only)
- Implement trust logic or chain walking (delegated to `@membership-card-protocol/verifier`)

**Monorepo structure:** This is a pnpm workspace containing the core `@membership-card-protocol/app-sdk` package (platform-independent TypeScript) and platform provider defaults in separate packages (`sdk-providers-web`, `sdk-providers-rn`).

---

## Setup

### Install

```sh
npm install @membership-card-protocol/app-sdk
# or
yarn add @membership-card-protocol/app-sdk
# or
pnpm add @membership-card-protocol/app-sdk
```

The App SDK depends on six provider interfaces for platform-specific I/O (secure key storage, passkey authentication, local persistence, realtime transport). See "[Provider interfaces](#provider-interfaces)" below.

### Initialize the SDK

The SDK requires a `CardVerifier` instance (for chain walking and verification):

```ts
import { createCardVerifier } from '@membership-card-protocol/app-sdk';

const cardVerifier = createCardVerifier({
  rpc: yourRpcProvider,  // implementation-specific (e.g., a Web3 provider)
  ipfs: yourIpfsProvider,  // IPFS or Filebase provider
  appCertificationRoot: '0x...',  // your app's trusted root on-chain
  trustedRoots: ['0x...'], // all trusted card issuer roots
  fetchAnnotations: false,  // set true if using EAS attestations
});
```

Then construct the SDK with provider instances:

```ts
import { SecureKeyProvider, StorageProvider, PasskeyProvider, /* ... */ } from '@membership-card-protocol/app-sdk';

// On web: use WebCryptoSecureKeyProvider, IndexedDBStorageProvider, WebAuthnPasskeyProvider, etc.
// On React Native: use SecureEnclaveKeyProvider, AsyncStorageProvider, ReactNativePasskeyProvider, etc.

const sdk = {
  cardVerifier,
  secureKeyProvider: yourSecureKeyProvider,
  storageProvider: yourStorageProvider,
  passkeyProvider: yourPasskeyProvider,
  realtimeTransportProvider: yourRealtimeProvider,
  multiInstanceLock: yourLockProvider,
};
```

---

## Provider Interfaces

The App SDK defines six provider interfaces that your integration must supply:

| Provider | Purpose | Web Default | RN Default |
|----------|---------|-------------|-----------|
| `SecureKeyProvider` | Non-exportable key generation and signing for sub-cards | `WebCryptoSecureKeyProvider` (IndexedDB-backed) | `SecureEnclaveKeyProvider` (Keychain-backed) |
| `StorageProvider` | Local key/blob persistence | IndexedDB | `AsyncStorage` |
| `PasskeyProvider` | Platform passkey/WebAuthn authentication | Web API (`navigator.credentials`) | `react-native-passkey` |
| `RealtimeTransportProvider` | SSE, WebSocket, and delivery confirmation | native `EventSource`/`WebSocket` | `react-native-sse` + native `WebSocket` |
| `MultiInstanceLock` | Coordinate between multiple concurrent device instances | IndexedDB-backed mutex | `AsyncStorage`-backed mutex |
| `ObliviousProtocolTransport` | HTTP transport with HPKE privacy wrapping for press/relay | Shared implementation across platforms |

All six interfaces are defined in `src/providers/` and documented in full in [`specs/object_specs/app_sdk.md` § Provider Interfaces](../specs/object_specs/app_sdk.md#4-provider-interfaces).

### Using Platform Defaults

For most integrations, you can use the shipped default providers:

**On web:**
```ts
import { WebCryptoSecureKeyProvider } from '@membership-card-protocol/sdk-providers-web';
import { IndexedDBStorageProvider } from '@membership-card-protocol/sdk-providers-web';
// ... and other web providers
```

**On React Native:**
```ts
import { SecureEnclaveKeyProvider } from '@membership-card-protocol/sdk-providers-rn';
import { AsyncStorageProvider } from '@membership-card-protocol/sdk-providers-rn';
// ... and other RN providers
```

### Custom Implementations

To supply your own provider implementation, implement the interface contract exactly as documented in the spec. For example, a custom `StorageProvider` for server-side use:

```ts
import type { StorageProvider } from '@membership-card-protocol/app-sdk';
import Database from 'your-database-library';

export class YourStorageProvider implements StorageProvider {
  async get(key: string): Promise<Uint8Array | undefined> {
    return Database.get(key); // your logic
  }
  async set(key: string, value: Uint8Array): Promise<void> {
    await Database.set(key, value);
  }
  async delete(key: string): Promise<void> {
    await Database.delete(key);
  }
}
```

---

## Security Posture and Disclosure

### `SecureKeyProvider` Security Gap (OQ-SDK-1)

**Web default** (`WebCryptoSecureKeyProvider`): Uses WebCrypto's non-extractable `CryptoKey` wrapped in AES-GCM and persisted via IndexedDB. This prevents casual code inspection of key material, but offers **software-only security** — a compromised page process can still decrypt the wrapped key during signing.

**React Native default** (`SecureEnclaveKeyProvider`): Uses `react-native-keychain` with `SECURE_HARDWARE` security level, storing the wrapping key in Secure Enclave (iOS) or StrongBox (Android). This provides **hardware-backed key custody** — the OS enforces that the wrapping key never leaves the secure element in cleartext.

**Recommendation:** Host web apps should prominently surface a persistent message recommending users install and use the native mobile app for stronger key protection. See `specs/object_specs/app_sdk.md § Resolved Design Decisions, OQ-SDK-1`.

### Server-Side Keystore (Split-SDK-2)

For server-side integrators (wallet-service, press, relay services) that use the App SDK but do not use the platform providers, implement your own `SecureKeyProvider` and `StorageProvider` to match your server's key custody and persistence strategy:

- **Secure key storage:** Use your infrastructure's HSM, KMS, or hardware key manager (e.g., AWS KMS, Google Cloud HSM).
- **Persistence:** Use your database or durable key store.

The App SDK provides only interfaces, not server implementations, because "secure key management on a server" depends entirely on your deployment, compliance posture, and risk model. `specs/object_specs/app_sdk.md § Resolved Design Decisions, Split-SDK-2` documents this decision.

---

## Examples

### Example 1: Web App with Default Providers

Construct the SDK and request a sub-card on behalf of an app user:

```ts
import {
  requestSubCard,
  mlDsa44GenerateKeypair,
  bytesToBase64Url,
} from '@membership-card-protocol/app-sdk';
import { WebCryptoSecureKeyProvider } from '@membership-card-protocol/sdk-providers-web';
import { IndexedDBStorageProvider } from '@membership-card-protocol/sdk-providers-web';

// 1. Set up providers.
const secureKeyProvider = new WebCryptoSecureKeyProvider();
const storageProvider = new IndexedDBStorageProvider('my-app-namespace');
// ... (other providers)

// 2. Construct the app's own card identity (normally set up once at app install).
const appCardKeypair = mlDsa44GenerateKeypair(); // or load from secure storage
const appCard = {
  cardPointer: 'app:example.com/my-app',
  publicKey: appCardKeypair.publicKey,
  sign: async (data: Uint8Array) => {
    // Sign with app's card key (non-extractable, via secureKeyProvider or similar)
    return mlDsa44Sign(appCardKeypair.secretKey, data);
  },
};

// 3. Request a sub-card on behalf of the user.
const result = await requestSubCard({
  secureKeyProvider,
  subCardKeyId: 'device-subcard-' + Date.now(),
  appCard,
  holderPrimaryCard: 'holder:example.com/primary',
  holderPrimaryCardPubkey: new Uint8Array(32).fill(0xaa), // from holder's card
  capabilities: ['text', 'reaction'],
  attestationLevel: 'T1', // or 'T2' with attestationProof
});

// 4. Send result.document to the wallet via your app's callback/deep-link channel.
// The wallet will receive, sign with its master key, and register via the press.

console.log('Sub-card requested. Public key:', bytesToBase64Url(result.subCardPublicKey));
```

### Example 2: Receive and Decrypt a Routed Message (Web)

When a device receives a routed message from the relay:

```ts
import {
  decryptRoutingEnvelope,
  handleInboundRoutingEnvelope,
  type RoutingEnvelope,
} from '@membership-card-protocol/app-sdk';

// 1. Receive routingEnvelope from the relay (via SSE, WebSocket, or GET /pending).
const routingEnvelope: RoutingEnvelope = { /* ... */ };

// 2. Decrypt using this device's sub-card ML-KEM key.
const envelopeDecrypted = decryptRoutingEnvelope(
  routingEnvelope,
  deviceSubCardMlKemSecretKey // persisted on this device
);

// 3. Verify and deduplicate against your CardVerifier and StorageProvider.
const inbound = await handleInboundRoutingEnvelope({
  routingEnvelope,
  mlKemSecretKey: deviceSubCardMlKemSecretKey,
  cardVerifier,
  storage: storageProvider,
});

if (inbound.accepted) {
  console.log('Message:', inbound.envelope.payload.content);
  // Persist, render, etc.
} else {
  console.log('Message rejected:', inbound.rejection);
}

// 4. Acknowledge to the relay (separate call, NOT implicit).
await ack({
  relayFetch: yourFetchFunction,
  deviceCredential: yourDeviceCredential,
  uuids: [inbound.messageId],
});
```

### Example 3: React Native App (Optional)

The RN equivalent is structurally identical, with RN-specific providers:

```ts
import {
  requestSubCard,
  /* ... */
} from '@membership-card-protocol/app-sdk';
import { SecureEnclaveKeyProvider } from '@membership-card-protocol/sdk-providers-rn';
import { AsyncStorageProvider } from '@membership-card-protocol/sdk-providers-rn';

// All the same SDK functions; only the provider implementations differ.
const secureKeyProvider = new SecureEnclaveKeyProvider();
const storageProvider = new AsyncStorageProvider('my-app-namespace');
// ... (other RN providers)

// requestSubCard, decryptRoutingEnvelope, handleInboundRoutingEnvelope, etc. —
// all work identically.
```

---

## Card Login (site side)

The `login` module lets a website log people in with a membership card ([`process_specs/card_login.md`](../specs/process_specs/card_login.md)). A site needs three routes: start a login, serve the signed request, and receive the response. The reference site used in the integration tests does this in 26 lines (`integration_tests/harnesses/web/test/login/referenceSite.ts`).

```ts
import {
  createLoginRequest, serveLoginRequest, handleFormPost, createInMemoryLoginStore,
  stateCookie, readStateCookie, routerLoginUrl,
} from '@membership-card-protocol/app-sdk';

const store = createInMemoryLoginStore();

// GET /login/start — sign a request and send the browser to the login router
const { requestId, state, request } = await createLoginRequest({
  server, keyProvider, store,                       // the site's server card and its key
  policies: [{ id: MEMBER_POLICY, include_children: true }],
  responseMode: 'form_post', responseUri: `${ORIGIN}/login/cb`, purpose: 'Log in to the member forum',
});
redirect(routerLoginUrl({ routerOrigin: ROUTER, requestUri: `${ORIGIN}/login/r/${requestId}` }),
  { 'set-cookie': stateCookie(state, request.expires_at, '/login') });

// GET /login/r/:id — the wallet fetches the signed request (once)
const r = await serveLoginRequest(store, id);       // 200 with the request, or 410

// POST /login/cb — verify the wallet's answer against this browser's state cookie
const result = await handleFormPost({ body: form, cookieState: readStateCookie(cookieHeader), store, verifier, expectedOrigin: ORIGIN });
if (result.ok) startSession(result.presentedCard);  // logged in as this card
```

Before the first login, the site's operator gets a **server card**: `createServerCardRequest` builds it, and the login service card's wallet authorizes it (wallet-sdk `authorizeServerCard`). The login service card must be certified under the login service branch and bound to the site's domain by its DNS admin card.

Other pieces: `mountLoginButton` (browser button), `crossDeviceLink` and `parseWalletStart` (QR and wallet-initiated logins), `handleLoginMessage` and `redeemLoginCode` (the cross-device `mcard_message` path, where the user types a one-time code), `loginStatus`, and `buildLoginServiceMetadata` (`/.well-known/membership-login`). Use a shared `LoginStore` instead of the in-memory one when the site runs on more than one instance. `createDevSecureKeyProvider` in `@membership-card-protocol/app-sdk/testing` is a non-secure key provider for tests.

---

## Development

```sh
pnpm install
pnpm -r build        # TypeScript compile
pnpm -r typecheck    # type-only check
pnpm -r test         # unit tests
pnpm -r lint         # ESLint + Prettier
```

All modules are in `packages/app-sdk/src/`.

---

## Documentation

- **Full spec:** [`specs/object_specs/app_sdk.md`](../specs/object_specs/app_sdk.md)
- **Protocol design:** [`specs/`](../specs) (card offering, sub-cards, messaging, relay)
- **Split strategy:** [`plans/sdk-split-strategic-plan.md`](../plans/sdk-split-strategic-plan.md)
- **Implementation progress:** See the `Implementation Status` table in `app_sdk.md`

**Other packages:**
- `@membership-card-protocol/wallet-sdk` — holder-side SDK with master-key custody, setup, and backup (see wallet-sdk's own README)
- `@membership-card-protocol/verifier` — verification, chain walking, and policy enforcement (shared by both SDKs)

---

## License

[See LICENSE](./LICENSE) (if included in this workspace).
