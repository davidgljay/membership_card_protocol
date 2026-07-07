import { describe, it, expect, vi } from 'vitest';
import { submitSubCardRegistration, createPressSubCardRegistrar } from '../../src/subcards/pressSubmission.js';
import { mlDsa44GenerateKeypair, mlDsa44Sign } from '../../src/crypto/mldsa.js';
import type { WalletAppCardIdentity, SignedSubCardDocument } from '../../src/subcards/types.js';
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
  it('adapts a successful submission to { registered: true } and can be plugged into any RegisterSubCardFn-typed caller', async () => {
    const transport: ObliviousProtocolTransport = {
      request: vi.fn(async () => jsonResponse(200, { sub_card_doc_cid: 'cid-123', tx_hash: '0xabc' })),
    };
    const registerSubCard = createPressSubCardRegistrar({ transport, pressBaseUrl: PRESS_BASE_URL });

    const walletAppCard = makeFakeWalletAppCard();
    const subCardKeypair = mlDsa44GenerateKeypair();
    const document: SignedSubCardDocument = {
      holder_primary_card: 'card-hash',
      holder_primary_card_pubkey: 'pubkey',
      app_card: walletAppCard.cardPointer,
      app_card_pubkey: 'app-pubkey',
      capabilities: ['auth_response'],
      recipient_pubkey: Buffer.from(subCardKeypair.publicKey).toString('base64url'),
      issued_at: new Date().toISOString(),
      attestation_level: 'T1',
      app_signature: 'sig',
      holder_signature: 'sig',
    };

    // registerSubCard is the exact RegisterSubCardFn-shaped callback that
    // Wallet SDK's own device-sub-card registration and countersign flows
    // accept as an injected dependency rather than talking to the press
    // directly — this exercises that same call shape end to end.
    const result = await registerSubCard(document);

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
