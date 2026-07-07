import type { PasskeyProvider } from '@membership-card-protocol/client-sdk';

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
      },
    })) as PublicKeyCredential;

    const response = credential.response as AuthenticatorAttestationResponse;
    return {
      credentialId: new Uint8Array(credential.rawId),
      attestationObject: new Uint8Array(response.attestationObject),
      clientDataJSON: new Uint8Array(response.clientDataJSON),
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
        ...(credentialId
          ? { allowCredentials: [{ id: new Uint8Array(credentialId), type: 'public-key' as const }] }
          : {}),
      },
    })) as PublicKeyCredential;

    const response = credential.response as AuthenticatorAssertionResponse;
    return {
      credentialId: new Uint8Array(credential.rawId),
      authenticatorData: new Uint8Array(response.authenticatorData),
      clientDataJSON: new Uint8Array(response.clientDataJSON),
      signature: new Uint8Array(response.signature),
    };
  }
}
