const mockCreate = jest.fn();
const mockGet = jest.fn();

jest.mock('react-native-passkey', () => ({
  Passkey: {
    create: (...args: unknown[]) => mockCreate(...args),
    get: (...args: unknown[]) => mockGet(...args),
  },
}));

import { bytesToBase64Url, base64UrlToBytes } from '@membership-card-protocol/app-sdk';
import { ReactNativePasskeyProvider } from '../../src/PasskeyProvider.js';

beforeEach(() => {
  mockCreate.mockReset();
  mockGet.mockReset();
});

describe('ReactNativePasskeyProvider', () => {
  it('register() base64url-encodes the challenge and maps the attestation result back to bytes', async () => {
    const challenge = new Uint8Array([1, 2, 3]);
    mockCreate.mockResolvedValue({
      rawId: bytesToBase64Url(new Uint8Array([9, 9, 9])),
      response: {
        attestationObject: bytesToBase64Url(new Uint8Array([4, 5, 6])),
        clientDataJSON: bytesToBase64Url(new Uint8Array([7, 8, 9])),
      },
    });

    const provider = new ReactNativePasskeyProvider({ rpId: 'example.com', rpName: 'Example' });
    const result = await provider.register(challenge);

    expect(mockCreate).toHaveBeenCalledTimes(1);
    const request = mockCreate.mock.calls[0]![0];
    expect(base64UrlToBytes(request.challenge)).toEqual(challenge);
    expect(request.rp).toEqual({ id: 'example.com', name: 'Example' });

    expect(result.credentialId).toEqual(new Uint8Array([9, 9, 9]));
    expect(result.attestationObject).toEqual(new Uint8Array([4, 5, 6]));
    expect(result.clientDataJSON).toEqual(new Uint8Array([7, 8, 9]));
  });

  it('assert() omits allowCredentials when no credentialId is supplied', async () => {
    mockGet.mockResolvedValue({
      rawId: bytesToBase64Url(new Uint8Array([1])),
      response: {
        authenticatorData: bytesToBase64Url(new Uint8Array([1])),
        clientDataJSON: bytesToBase64Url(new Uint8Array([2])),
        signature: bytesToBase64Url(new Uint8Array([3])),
      },
    });

    const provider = new ReactNativePasskeyProvider({ rpId: 'example.com' });
    await provider.assert(new Uint8Array([1, 2, 3]));

    const request = mockGet.mock.calls[0]![0];
    expect('allowCredentials' in request).toBe(false);
  });

  it('assert() includes a base64url-encoded allowCredentials entry when a credentialId is supplied', async () => {
    mockGet.mockResolvedValue({
      rawId: bytesToBase64Url(new Uint8Array([1])),
      response: {
        authenticatorData: bytesToBase64Url(new Uint8Array([1])),
        clientDataJSON: bytesToBase64Url(new Uint8Array([2])),
        signature: bytesToBase64Url(new Uint8Array([3])),
      },
    });

    const credentialId = new Uint8Array([5, 5, 5]);
    const provider = new ReactNativePasskeyProvider({ rpId: 'example.com' });
    await provider.assert(new Uint8Array([1, 2, 3]), credentialId);

    const request = mockGet.mock.calls[0]![0];
    expect(base64UrlToBytes(request.allowCredentials[0].id)).toEqual(credentialId);
  });
});
