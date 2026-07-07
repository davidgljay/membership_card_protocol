import { Passkey } from 'react-native-passkey';
import type { PasskeyProvider } from '@membership-card-protocol/client-sdk';
import { bytesToBase64Url, base64UrlToBytes } from './base64url.js';

export interface ReactNativePasskeyProviderOptions {
  rpId: string;
  rpName?: string;
  userName?: string;
}

/**
 * Default React Native `PasskeyProvider` (OQ-SDK-2), wrapping
 * `react-native-passkey` — the shipped RN default; a host app may inject
 * its own implementation to override it.
 *
 * `react-native-passkey`'s bridge is JSON, so every binary field crosses
 * as base64url rather than raw bytes.
 */
export class ReactNativePasskeyProvider implements PasskeyProvider {
  readonly #options: ReactNativePasskeyProviderOptions;

  constructor(options: ReactNativePasskeyProviderOptions) {
    this.#options = options;
  }

  async register(challenge: Uint8Array): ReturnType<PasskeyProvider['register']> {
    const rpId = this.#options.rpId;
    const rpName = this.#options.rpName ?? rpId;
    const userName = this.#options.userName ?? 'Card Protocol Wallet';
    const userId = bytesToBase64Url(crypto.getRandomValues(new Uint8Array(16)));

    const result = await Passkey.create({
      challenge: bytesToBase64Url(challenge),
      rp: { id: rpId, name: rpName },
      user: { id: userId, name: userName, displayName: userName },
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
      authenticatorSelection: { userVerification: 'required', residentKey: 'required' },
    });

    return {
      credentialId: base64UrlToBytes(result.rawId),
      attestationObject: base64UrlToBytes(result.response.attestationObject),
      clientDataJSON: base64UrlToBytes(result.response.clientDataJSON),
    };
  }

  async assert(
    challenge: Uint8Array,
    credentialId?: Uint8Array
  ): ReturnType<PasskeyProvider['assert']> {
    const result = await Passkey.get({
      challenge: bytesToBase64Url(challenge),
      rpId: this.#options.rpId,
      userVerification: 'required',
      ...(credentialId
        ? { allowCredentials: [{ id: bytesToBase64Url(credentialId), type: 'public-key' as const }] }
        : {}),
    });

    return {
      credentialId: base64UrlToBytes(result.rawId ?? result.id),
      authenticatorData: base64UrlToBytes(result.response.authenticatorData),
      clientDataJSON: base64UrlToBytes(result.response.clientDataJSON),
      signature: base64UrlToBytes(result.response.signature),
    };
  }
}
