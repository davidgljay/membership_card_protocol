// Integration test for POST /ohttp/{target_id} — client-sdk implementation
// plan Step 1.4b's "Done when": a request carrying an opaque test blob is
// forwarded byte-for-byte to the configured ohttp_gateway_url for both a
// wallet-service-shaped and a press-shaped registry entry, the stub
// gateway's response is returned byte-for-byte to the caller, and an
// unknown target_id returns 404 without attempting any forward.
//
// Runs against the REAL built node-server output, same as
// relay-flow.test.ts, via startHttpServerHarness — see that file's module
// doc for why (proving the handler works end-to-end, not just in
// isolation with a fake H3Event).
//
// Requires `npm run build:node` to have been run first.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startHttpServerHarness, type HttpServerHarness } from './http-server-harness';
import { startStubHttpsServer, type StubHttpsServerHandle } from './stub-https-server';

let harness: HttpServerHarness;
let walletServiceStub: StubHttpsServerHandle;
let pressStub: StubHttpsServerHandle;

beforeEach(async () => {
  walletServiceStub = await startStubHttpsServer();
  pressStub = await startStubHttpsServer();

  harness = await startHttpServerHarness({
    appRegistryFile: { apps: [] },
    obliviousTargetsFile: {
      targets: [
        { target_id: 'wallet-service-1', ohttp_gateway_url: `${walletServiceStub.baseUrl}/ohttp/gateway` },
        { target_id: 'press-1', ohttp_gateway_url: `${pressStub.baseUrl}/ohttp/gateway` },
      ],
    },
    extraCaCertPems: [walletServiceStub.certPem, pressStub.certPem],
  });
});

afterEach(async () => {
  await harness.teardown();
  await walletServiceStub.close();
  await pressStub.close();
});

describe('POST /ohttp/{target_id} (client-sdk implementation plan Step 1.4b)', () => {
  it('forwards an opaque blob byte-for-byte to the wallet-service-shaped target and returns the gateway response byte-for-byte', async () => {
    const opaqueBlob = JSON.stringify({ enc: 'ZmFrZS1lbmM', ciphertext: 'ZmFrZS1jaXBoZXJ0ZXh0' });

    const res = await fetch(`${harness.baseUrl}/api/ohttp/wallet-service-1`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: opaqueBlob,
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { echoed: boolean; contentType: string; bodyBase64: string };
    expect(body.echoed).toBe(true);
    expect(body.contentType).toBe('application/json');
    expect(Buffer.from(body.bodyBase64, 'base64').toString('utf-8')).toBe(opaqueBlob);

    expect(walletServiceStub.requests).toHaveLength(1);
    expect(walletServiceStub.requests[0]!.body.toString('utf-8')).toBe(opaqueBlob);
    expect(pressStub.requests).toHaveLength(0);
  });

  it('forwards an opaque blob byte-for-byte to a press-shaped target', async () => {
    const opaqueBlob = JSON.stringify({ enc: 'cHJlc3MtZW5j', ciphertext: 'cHJlc3MtY2lwaGVydGV4dA' });

    const res = await fetch(`${harness.baseUrl}/api/ohttp/press-1`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: opaqueBlob,
    });

    expect(res.status).toBe(200);
    expect(pressStub.requests).toHaveLength(1);
    expect(pressStub.requests[0]!.body.toString('utf-8')).toBe(opaqueBlob);
    expect(walletServiceStub.requests).toHaveLength(0);
  });

  it('returns 404 for an unknown target_id without attempting any forward', async () => {
    const res = await fetch(`${harness.baseUrl}/api/ohttp/unknown-target`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });

    expect(res.status).toBe(404);
    expect(walletServiceStub.requests).toHaveLength(0);
    expect(pressStub.requests).toHaveLength(0);
  });
});
