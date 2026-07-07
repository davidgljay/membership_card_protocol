import { describe, it, expect, vi } from 'vitest';
import {
  deregisterSubCard,
  deregisterSubCardsAfterRecovery,
} from '../../src/wallet/subCardDeregistration.js';
import {
  mlDsa44GenerateKeypair,
  mlDsa44Verify,
  canonicalize,
  keccak256,
} from '@membership-card-protocol/app-sdk';
import { base64UrlToBytes } from '@membership-card-protocol/app-sdk';
import type {
  ObliviousProtocolTransport,
  ObliviousDestination,
  RequestOptions,
  ObliviousResponse,
} from '@membership-card-protocol/app-sdk';

function jsonResponse(status: number, body: unknown): ObliviousResponse {
  return { status, headers: {}, body: new TextEncoder().encode(JSON.stringify(body)) };
}

function readJsonBody(options: RequestOptions): Record<string, unknown> {
  if (!options.body) return {};
  return JSON.parse(new TextDecoder().decode(options.body)) as Record<string, unknown>;
}

describe('deregisterSubCard', () => {
  it('signs sig_payload with the master key only and submits to the given press', async () => {
    const master = mlDsa44GenerateKeypair();
    const subCardKeypair = mlDsa44GenerateKeypair();
    const calls: Array<{ destination: ObliviousDestination; options: RequestOptions }> = [];
    const transport: ObliviousProtocolTransport = {
      request: vi.fn(async (destination, options) => {
        calls.push({ destination, options });
        return jsonResponse(200, { tx_hash: '0xdeadbeef' });
      }),
    };

    const result = await deregisterSubCard({
      transport,
      press: { baseUrl: 'https://press.example' },
      subCardPublicKey: subCardKeypair.publicKey,
      masterSecretKey: master.secretKey,
    });

    expect(result.txHash).toBe('0xdeadbeef');
    expect(calls).toHaveLength(1);
    const { destination, options } = calls[0]!;
    expect(destination).toEqual({ kind: 'press', baseUrl: 'https://press.example' });
    expect(options.method).toBe('POST');
    expect(options.path).toBe('/sub-card/deregister');

    const body = readJsonBody(options);
    const expectedSubCardAddress = keccak256(subCardKeypair.publicKey);
    expect(body.sub_card_address).toBe(expectedSubCardAddress);
    expect((body.sig_payload as { sub_card_address: string }).sub_card_address).toBe(expectedSubCardAddress);
    expect((body.sig_payload as { op: string }).op).toBe('deregister_sub_card');

    // The signature verifies against the MASTER public key over the exact
    // canonicalized sig_payload — never the sub-card key.
    const signature = base64UrlToBytes(body.master_signature as string);
    expect(mlDsa44Verify(master.publicKey, canonicalize(body.sig_payload), signature)).toBe(true);
    expect(mlDsa44Verify(subCardKeypair.publicKey, canonicalize(body.sig_payload), signature)).toBe(false);
  });

  it('has no parameter through which a sub-card or app key could be used as the signer', () => {
    // Structural check: deregisterSubCard's only signing-key-shaped input
    // is `masterSecretKey`. There is no injectable "signer" callback (unlike
    // deviceSubCard.ts's WalletAppCardIdentity.sign) that a caller could
    // point at a different key — the function signature itself is the
    // enforcement mechanism subcards.md's "Authorization for Deregistration"
    // requires (a sub-card/app key literally cannot be substituted without
    // passing it as `masterSecretKey`, which then IS what gets used, by
    // construction — there is no way to have this call sign with one key
    // while claiming to be another).
    expect(deregisterSubCard.length).toBe(1); // single `options` object parameter
  });

  it('throws on a non-2xx response', async () => {
    const master = mlDsa44GenerateKeypair();
    const subCardKeypair = mlDsa44GenerateKeypair();
    const transport: ObliviousProtocolTransport = {
      request: vi.fn(async () => jsonResponse(500, { error: 'press unavailable' })),
    };

    await expect(
      deregisterSubCard({
        transport,
        press: { baseUrl: 'https://press.example' },
        subCardPublicKey: subCardKeypair.publicKey,
        masterSecretKey: master.secretKey,
      })
    ).rejects.toThrow(/returned status 500/);
  });
});

describe('deregisterSubCardsAfterRecovery', () => {
  it('submits one request per sub-card, to each one\'s own press, and reports per-item outcomes', async () => {
    const master = mlDsa44GenerateKeypair();
    const subCardA = mlDsa44GenerateKeypair();
    const subCardB = mlDsa44GenerateKeypair();

    const requestedPresses: string[] = [];
    const transport: ObliviousProtocolTransport = {
      request: vi.fn(async (destination: ObliviousDestination) => {
        if (destination.kind === 'press') requestedPresses.push(destination.baseUrl);
        return jsonResponse(200, { tx_hash: `tx-${requestedPresses.length}` });
      }),
    };

    const outcomes = await deregisterSubCardsAfterRecovery(transport, master.secretKey, [
      { subCardPublicKey: subCardA.publicKey, press: { baseUrl: 'https://press-a.example' } },
      { subCardPublicKey: subCardB.publicKey, press: { baseUrl: 'https://press-b.example' } },
    ]);

    expect(requestedPresses).toEqual(['https://press-a.example', 'https://press-b.example']);
    expect(outcomes).toHaveLength(2);
    expect(outcomes[0]!.subCardAddress).toBe(keccak256(subCardA.publicKey));
    expect(outcomes[0]!.deregistered).toBe(true);
    expect(outcomes[0]!.txHash).toBe('tx-1');
    expect(outcomes[1]!.subCardAddress).toBe(keccak256(subCardB.publicKey));
    expect(outcomes[1]!.deregistered).toBe(true);
  });

  it('does not let one failed deregistration abort the rest of the batch', async () => {
    const master = mlDsa44GenerateKeypair();
    const subCardA = mlDsa44GenerateKeypair();
    const subCardB = mlDsa44GenerateKeypair();

    const transport: ObliviousProtocolTransport = {
      request: vi.fn(async (destination: ObliviousDestination) => {
        if (destination.kind === 'press' && destination.baseUrl === 'https://press-a.example') {
          return jsonResponse(500, { error: 'unavailable' });
        }
        return jsonResponse(200, { tx_hash: 'tx-b' });
      }),
    };

    const outcomes = await deregisterSubCardsAfterRecovery(transport, master.secretKey, [
      { subCardPublicKey: subCardA.publicKey, press: { baseUrl: 'https://press-a.example' } },
      { subCardPublicKey: subCardB.publicKey, press: { baseUrl: 'https://press-b.example' } },
    ]);

    expect(outcomes[0]!.deregistered).toBe(false);
    expect(outcomes[0]!.error).toMatch(/returned status 500/);
    expect(outcomes[1]!.deregistered).toBe(true);
    expect(outcomes[1]!.txHash).toBe('tx-b');
  });
});
