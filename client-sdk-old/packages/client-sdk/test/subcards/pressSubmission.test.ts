import { describe, it, expect, vi } from 'vitest';
import { submitSubCardRegistration, createPressSubCardRegistrar } from '../../src/subcards/pressSubmission.js';
import { registerDeviceSubCard } from '../../src/wallet/deviceSubCard.js';
import { mlDsa44GenerateKeypair, mlDsa44Sign } from '../../src/crypto/mldsa.js';
import { keccak256 } from '../../src/crypto/hashes.js';
import type { WalletAppCardIdentity, SignedSubCardDocument } from '../../src/wallet/deviceSubCard.js';
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

const PRESS_BASE_URL = 'https://press.example';

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

function makeFakeWalletAppCard(): WalletAppCardIdentity {
  const keypair = mlDsa44GenerateKeypair();
  return {
    cardPointer: 'wallet-app-card-pointer',
    publicKey: keypair.publicKey,
    sign: (message: Uint8Array) => mlDsa44Sign(keypair.secretKey, message),
  };
}

describe('submitSubCardRegistration', () => {
  it('POSTs the document to /sub-card/register via the destination-parameterized transport and parses the response', async () => {
    const document = { fake: 'document' } as unknown as SignedSubCardDocument;
    const calls: Array<{ destination: ObliviousDestination; options: RequestOptions }> = [];
    const transport: ObliviousProtocolTransport = {
      request: vi.fn(async (destination, options) => {
        calls.push({ destination, options });
        return jsonResponse(200, { sub_card_doc_cid: 'cid-123', tx_hash: '0xabc' });
      }),
    };

    const result = await submitSubCardRegistration(document, { transport, pressBaseUrl: PRESS_BASE_URL });

    expect(result).toEqual({ subCardDocCid: 'cid-123', txHash: '0xabc' });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.destination).toEqual({ kind: 'press', baseUrl: PRESS_BASE_URL });
    expect(calls[0]!.options.path).toBe('/sub-card/register');
    expect(calls[0]!.options.method).toBe('POST');
    const sentBody = JSON.parse(new TextDecoder().decode(calls[0]!.options.body));
    expect(sentBody).toEqual(document);
  });

  it('throws on a non-2xx response', async () => {
    const transport: ObliviousProtocolTransport = {
      request: vi.fn(async () => jsonResponse(400, { error: 'bad request' })),
    };

    await expect(
      submitSubCardRegistration({} as SignedSubCardDocument, { transport, pressBaseUrl: PRESS_BASE_URL })
    ).rejects.toThrow(/returned status 400/);
  });
});

describe('createPressSubCardRegistrar', () => {
  it('adapts a successful submission to { registered: true } and can be plugged directly into registerDeviceSubCard', async () => {
    const transport: ObliviousProtocolTransport = {
      request: vi.fn(async () => jsonResponse(200, { sub_card_doc_cid: 'cid-123', tx_hash: '0xabc' })),
    };
    const registerSubCard = createPressSubCardRegistrar({ transport, pressBaseUrl: PRESS_BASE_URL });

    const secureKeyProvider = makeFakeSecureKeyProvider();
    const walletAppCard = makeFakeWalletAppCard();
    const master = mlDsa44GenerateKeypair();

    const result = await registerDeviceSubCard({
      secureKeyProvider,
      cardHash: keccak256(master.publicKey),
      masterPublicKey: master.publicKey,
      masterSecretKey: master.secretKey,
      walletAppCard,
      registerSubCard,
      capabilities: ['auth_response'],
    });

    expect(result.registered).toBe(true);
    expect(transport.request).toHaveBeenCalledTimes(1);
  });

  it('adapts a failed submission to { registered: false } rather than throwing', async () => {
    const transport: ObliviousProtocolTransport = {
      request: vi.fn(async () => jsonResponse(500, { error: 'press unavailable' })),
    };
    const registerSubCard = createPressSubCardRegistrar({ transport, pressBaseUrl: PRESS_BASE_URL });

    const result = await registerSubCard({} as SignedSubCardDocument);
    expect(result).toEqual({ registered: false });
  });
});
