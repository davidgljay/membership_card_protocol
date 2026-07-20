import type { PasskeyProvider } from '@membership-card-protocol/app-sdk';

export interface WebAuthnPasskeyProviderOptions {
  /** Relying party ID. Defaults to `window.location.hostname`. */
  rpId?: string;
  /** Relying party display name. Defaults to `rpId`. */
  rpName?: string;
  /**
   * Display name shown in the platform's passkey UI at registration. The
   * `register(challenge)` interface (Step 1.2) doesn't carry per-call user
   * identity, so this is fixed per provider instance; the user handle
   * itself is a fresh random value generated on every `register` call.
   */
  userName?: string;
}

/**
 * Fixed salt for the WebAuthn PRF extension's `eval.first` input. The PRF
 * extension yields a deterministic secret as a function of (credential,
 * salt) — any fixed salt works, as long as the same one is used on every
 * `register()`/`assert()` call for a given credential, since a later
 * `assert()` (e.g. during recovery, on a different device, per
 * `wallet-sdk`'s `recovery.ts`) must reproduce the exact same output
 * `register()` returned. Not secret — the salt only needs to be constant,
 * not hidden (see `kdf.ts`'s `passkeyOutputFromPrf` for how the output
 * itself is used).
 */
const PRF_SALT = (() => {
  const salt = new Uint8Array(32);
  salt.set(new TextEncoder().encode('card-protocol-passkey-prf-v1').slice(0, 32));
  return salt;
})();

function readPrfOutput(credential: PublicKeyCredential): Uint8Array | undefined {
  const extensionResults = credential.getClientExtensionResults() as {
    prf?: { results?: { first?: ArrayBuffer } };
  };
  const first = extensionResults.prf?.results?.first;
  return first ? new Uint8Array(first) : undefined;
}

/**
 * Default web `PasskeyProvider` (OQ-SDK-2): wraps `navigator.credentials`
 * (WebAuthn).
 */
export class WebAuthnPasskeyProvider implements PasskeyProvider {
  readonly #options: WebAuthnPasskeyProviderOptions;

  constructor(options: WebAuthnPasskeyProviderOptions = {}) {
    this.#options = options;
  }

  async register(challenge: Uint8Array): ReturnType<PasskeyProvider['register']> {
    const rpId = this.#options.rpId ?? window.location.hostname;
    const rpName = this.#options.rpName ?? rpId;
    const userName = this.#options.userName ?? 'Card Protocol Wallet';
    const userId = crypto.getRandomValues(new Uint8Array(16));

    const credential = (await navigator.credentials.create({
      publicKey: {
        challenge: new Uint8Array(challenge),
        rp: { id: rpId, name: rpName },
        user: { id: userId, name: userName, displayName: userName },
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
        authenticatorSelection: { userVerification: 'required', residentKey: 'required' },
        extensions: { prf: { eval: { first: PRF_SALT } } } as AuthenticationExtensionsClientInputs,
      },
    })) as PublicKeyCredential;

    const response = credential.response as AuthenticatorAttestationResponse;
    const prfOutput = readPrfOutput(credential);
    return {
      credentialId: new Uint8Array(credential.rawId),
      attestationObject: new Uint8Array(response.attestationObject),
      clientDataJSON: new Uint8Array(response.clientDataJSON),
      ...(prfOutput ? { prfOutput } : {}),
    };
  }

  async assert(
    challenge: Uint8Array,
    credentialId?: Uint8Array
  ): ReturnType<PasskeyProvider['assert']> {
    const credential = (await navigator.credentials.get({
      publicKey: {
        challenge: new Uint8Array(challenge),
        rpId: this.#options.rpId ?? window.location.hostname,
        userVerification: 'required',
        extensions: { prf: { eval: { first: PRF_SALT } } } as AuthenticationExtensionsClientInputs,
        ...(credentialId
          ? { allowCredentials: [{ id: new Uint8Array(credentialId), type: 'public-key' as const }] }
          : {}),
      },
    })) as PublicKeyCredential;

    const response = credential.response as AuthenticatorAssertionResponse;
    const prfOutput = readPrfOutput(credential);
    return {
      credentialId: new Uint8Array(credential.rawId),
      authenticatorData: new Uint8Array(response.authenticatorData),
      clientDataJSON: new Uint8Array(response.clientDataJSON),
      signature: new Uint8Array(response.signature),
      ...(prfOutput ? { prfOutput } : {}),
    };
  }
}
