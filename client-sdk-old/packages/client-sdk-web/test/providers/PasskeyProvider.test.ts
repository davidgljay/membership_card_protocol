import { describe, it, expect, vi, afterEach } from 'vitest';
import { WebAuthnPasskeyProvider } from '../../src/PasskeyProvider.js';

/**
 * jsdom does not implement WebAuthn (`navigator.credentials` is undefined
 * — confirmed empirically), so these tests mock `navigator.credentials`
 * directly rather than exercising a real authenticator ceremony. They
 * verify the provider's glue code: it builds correctly-shaped
 * `PublicKeyCredentialCreationOptions`/`...RequestOptions`, and maps the
 * (mocked) credential response back onto the `PasskeyProvider` interface
 * shape. The Step 1.2 `passkeyProviderContractTests` suite is still an
 * intentional placeholder (empty) until a fake-authenticator double
 * exists to run it against.
 */

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubCredentialsContainer(overrides: Partial<CredentialsContainer>) {
  vi.stubGlobal('navigator', {
    ...globalThis.navigator,
    credentials: overrides,
  });
}

describe('WebAuthnPasskeyProvider', () => {
  it('register() passes the challenge through and maps the attestation response', async () => {
    const challenge = new Uint8Array([1, 2, 3]);
    const rawId = new Uint8Array([9, 9, 9]).buffer;
    const attestationObject = new Uint8Array([4, 5, 6]).buffer;
    const clientDataJSON = new Uint8Array([7, 8, 9]).buffer;

    const create = vi.fn().mockResolvedValue({
      rawId,
      response: { attestationObject, clientDataJSON },
    });
    stubCredentialsContainer({ create } as unknown as Partial<CredentialsContainer>);

    const provider = new WebAuthnPasskeyProvider({ rpId: 'example.com', rpName: 'Example' });
    const result = await provider.register(challenge);

    expect(create).toHaveBeenCalledTimes(1);
    const options = create.mock.calls[0][0].publicKey;
    expect(new Uint8Array(options.challenge)).toEqual(challenge);
    expect(options.rp).toEqual({ id: 'example.com', name: 'Example' });

    expect(result.credentialId).toEqual(new Uint8Array(rawId));
    expect(result.attestationObject).toEqual(new Uint8Array(attestationObject));
    expect(result.clientDataJSON).toEqual(new Uint8Array(clientDataJSON));
  });

  it('assert() omits allowCredentials when no credentialId is supplied', async () => {
    const rawId = new Uint8Array([1]).buffer;
    const get = vi.fn().mockResolvedValue({
      rawId,
      response: {
        authenticatorData: new Uint8Array([1]).buffer,
        clientDataJSON: new Uint8Array([2]).buffer,
        signature: new Uint8Array([3]).buffer,
      },
    });
    stubCredentialsContainer({ get } as unknown as Partial<CredentialsContainer>);

    const provider = new WebAuthnPasskeyProvider({ rpId: 'example.com' });
    await provider.assert(new Uint8Array([1, 2, 3]));

    const options = get.mock.calls[0][0].publicKey;
    expect('allowCredentials' in options).toBe(false);
  });

  it('assert() includes allowCredentials when a credentialId is supplied', async () => {
    const credentialId = new Uint8Array([5, 5, 5]);
    const rawId = new Uint8Array([1]).buffer;
    const get = vi.fn().mockResolvedValue({
      rawId,
      response: {
        authenticatorData: new Uint8Array([1]).buffer,
        clientDataJSON: new Uint8Array([2]).buffer,
        signature: new Uint8Array([3]).buffer,
      },
    });
    stubCredentialsContainer({ get } as unknown as Partial<CredentialsContainer>);

    const provider = new WebAuthnPasskeyProvider({ rpId: 'example.com' });
    await provider.assert(new Uint8Array([1, 2, 3]), credentialId);

    const options = get.mock.calls[0][0].publicKey;
    expect(new Uint8Array(options.allowCredentials[0].id)).toEqual(credentialId);
  });
});
