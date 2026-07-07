import { describe, it, expect } from 'vitest';
import { mlDsa44GenerateKeypair, mlDsa44Sign, mlDsa44Verify } from '../../src/crypto/mldsa.js';
import { canonicalize } from '../../src/crypto/canonicalize.js';
import { deregisterCardUuids } from '../../src/messaging/uuidDeregistration.js';
import { registerCardUuids } from '../../src/messaging/uuidRegistration.js';
import { bytesToBase64Url, base64UrlToBytes } from '../../src/util/base64url.js';
import type { ObliviousProtocolTransport } from '../../src/providers/ObliviousProtocolTransport.js';

/**
 * A minimal stub wallet service that models exactly the subset of
 * `notification_relay.md §Multi-Device Support "Deregistration"` and
 * `§Process 1` step 7 this test needs: it tracks one subcard's UUID pool
 * and whether it is currently "registered" at all, verifying every
 * request's signature against the subcard's known public key before
 * accepting it — mirroring the wallet service's own verification (steps
 * 1-6 of the deregistration spec section), without a real chain/IPFS
 * fetch.
 */
function makeStubWalletService(subCardPublicKey: Uint8Array) {
  const state = {
    registered: false,
    uuids: [] as string[],
  };

  const transport: ObliviousProtocolTransport = {
    async request(_destination, options) {
      const body = options.body ? JSON.parse(new TextDecoder().decode(options.body)) : undefined;

      if (options.method === 'POST' && options.path.endsWith('/uuids')) {
        const { payload, signature } = body as {
          payload: { uuids: string[]; public_key: string; [key: string]: unknown };
          signature: string;
        };
        // registerCardUuids signs the payload BEFORE public_key is added to
        // the wire body (see uuidRegistration.ts) — verify against the
        // same fields that were actually signed, not the wire body's
        // superset shape.
        const signedPayload = { ...payload };
        delete (signedPayload as { public_key?: string }).public_key;
        const valid = verifySignedPayload(subCardPublicKey, signedPayload, signature);
        if (!valid) return { status: 401, headers: {}, body: new Uint8Array() };
        state.registered = true;
        state.uuids = payload.uuids;
        return { status: 200, headers: {}, body: new Uint8Array() };
      }

      if (options.method === 'DELETE') {
        const { payload, signature } = body as { payload: unknown; signature: string };
        const valid = verifySignedPayload(subCardPublicKey, payload, signature);
        if (!valid) return { status: 401, headers: {}, body: new Uint8Array() };
        if (!state.registered) return { status: 404, headers: {}, body: new Uint8Array() };
        state.registered = false;
        state.uuids = [];
        return { status: 204, headers: {}, body: new Uint8Array() };
      }

      throw new Error(`unexpected request: ${options.method} ${options.path}`);
    },
  };

  return { transport, state };
}

function verifySignedPayload(publicKey: Uint8Array, payload: unknown, signatureB64: string): boolean {
  return mlDsa44Verify(publicKey, canonicalize(payload), base64UrlToBytes(signatureB64));
}

describe('deregisterCardUuids (Step 5.6)', () => {
  it('succeeds with a valid signed envelope', async () => {
    const keypair = mlDsa44GenerateKeypair();
    const { transport, state } = makeStubWalletService(keypair.publicKey);

    await registerCardUuids({
      transport,
      cardHash: 'card-1',
      subCardHash: 'subcard-1',
      uuids: ['u1', 'u2'],
      sign: (m) => mlDsa44Sign(keypair.secretKey, m),
      subCardPublicKey: bytesToBase64Url(keypair.publicKey),
    });
    expect(state.registered).toBe(true);

    const result = await deregisterCardUuids({
      transport,
      cardHash: 'card-1',
      subCardHash: 'subcard-1',
      sign: (m) => mlDsa44Sign(keypair.secretKey, m),
    });

    expect(result.deregistered).toBe(true);
    expect(state.registered).toBe(false);
    expect(state.uuids).toEqual([]);
  });

  it('is rejected without a valid signed envelope (wrong signer)', async () => {
    const keypair = mlDsa44GenerateKeypair();
    const wrongKeypair = mlDsa44GenerateKeypair();
    const { transport, state } = makeStubWalletService(keypair.publicKey);

    await registerCardUuids({
      transport,
      cardHash: 'card-1',
      subCardHash: 'subcard-1',
      uuids: ['u1'],
      sign: (m) => mlDsa44Sign(keypair.secretKey, m),
      subCardPublicKey: bytesToBase64Url(keypair.publicKey),
    });

    const result = await deregisterCardUuids({
      transport,
      cardHash: 'card-1',
      subCardHash: 'subcard-1',
      // Signed by a DIFFERENT key than the registered subcard's own —
      // the wallet service must reject this, proving deregistration
      // requires the subcard's own private key, not just knowledge of
      // the card_hash/subcard_hash pair.
      sign: (m) => mlDsa44Sign(wrongKeypair.secretKey, m),
    });

    expect(result.deregistered).toBe(false);
    // The pool must remain intact — an invalid signature must not have
    // wiped a legitimate device's UUID pool.
    expect(state.registered).toBe(true);
  });

  it('re-registration immediately after deregistration resumes normal delivery — deregistration is not conflated with on-chain sub-card revocation', async () => {
    const keypair = mlDsa44GenerateKeypair();
    const { transport, state } = makeStubWalletService(keypair.publicKey);
    const sign = (m: Uint8Array) => mlDsa44Sign(keypair.secretKey, m);

    await registerCardUuids({
      transport,
      cardHash: 'card-1',
      subCardHash: 'subcard-1',
      uuids: ['u1', 'u2'],
      sign,
      subCardPublicKey: bytesToBase64Url(keypair.publicKey),
    });

    const deregResult = await deregisterCardUuids({
      transport,
      cardHash: 'card-1',
      subCardHash: 'subcard-1',
      sign,
    });
    expect(deregResult.deregistered).toBe(true);
    expect(state.registered).toBe(false);

    // Immediately re-register — this must succeed exactly as it would for
    // a subcard that was never deregistered. Nothing about this module
    // reads or writes any on-chain revocation flag, so there is nothing
    // that could block this.
    const reregResult = await registerCardUuids({
      transport,
      cardHash: 'card-1',
      subCardHash: 'subcard-1',
      uuids: ['u3', 'u4'],
      sign,
      subCardPublicKey: bytesToBase64Url(keypair.publicKey),
    });

    expect(reregResult.registered).toBe(true);
    expect(state.registered).toBe(true);
    expect(state.uuids).toEqual(['u3', 'u4']);
  });

  it('returns deregistered:false (not a thrown exception) when the subcard was never registered (404 from the wallet service)', async () => {
    const keypair = mlDsa44GenerateKeypair();
    const { transport } = makeStubWalletService(keypair.publicKey);

    const result = await deregisterCardUuids({
      transport,
      cardHash: 'card-never-registered',
      subCardHash: 'subcard-never-registered',
      sign: (m) => mlDsa44Sign(keypair.secretKey, m),
    });

    expect(result.deregistered).toBe(false);
  });
});
