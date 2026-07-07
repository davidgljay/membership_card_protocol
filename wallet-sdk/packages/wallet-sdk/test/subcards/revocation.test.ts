import { describe, it, expect, vi } from 'vitest';
import { revokeSubCard, type SubCardRevocationCode } from '../../src/subcards/revocation.js';
import {
  canonicalize,
  mlDsa44GenerateKeypair,
  mlDsa44Sign,
  mlDsa44Verify,
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

const PRESS_BASE_URL = 'https://press.example';
const TARGET_SUB_CARD = 'target-sub-card-pointer';

function makeStubPress() {
  const calls: Array<{ destination: ObliviousDestination; body: Record<string, unknown> }> = [];
  const transport: ObliviousProtocolTransport = {
    request: vi.fn(async (destination: ObliviousDestination, options: RequestOptions) => {
      const body = readJsonBody(options);
      calls.push({ destination, body });
      return jsonResponse(200, { log_entry_cid: 'log-entry-cid', new_log_head_cid: 'new-log-head-cid' });
    }),
  };
  return { transport, calls };
}

describe('revokeSubCard', () => {
  it('user-initiated (code 801, signed by the device sub-card key) succeeds', async () => {
    const { transport, calls } = makeStubPress();
    const deviceSubCard = mlDsa44GenerateKeypair();
    const updater = {
      cardPointer: 'device-sub-card-pointer',
      sign: (message: Uint8Array) => mlDsa44Sign(deviceSubCard.secretKey, message),
    };

    const result = await revokeSubCard({
      transport,
      pressBaseUrl: PRESS_BASE_URL,
      targetSubCard: TARGET_SUB_CARD,
      updater,
      code: 801,
      note: 'user revoked app access',
    });

    expect(result).toEqual({ logEntryCid: 'log-entry-cid', newLogHeadCid: 'new-log-head-cid' });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.destination).toEqual({ kind: 'press', baseUrl: PRESS_BASE_URL });

    const body = calls[0]!.body;
    const updateIntent = body.update_intent as Record<string, unknown>;
    expect(updateIntent.target_card).toBe(TARGET_SUB_CARD);
    expect(updateIntent.updater_card).toBe('device-sub-card-pointer');
    expect(updateIntent.code).toBe(801);
    expect(updateIntent.revocation).toEqual({ effective_date: expect.any(String), note: 'user revoked app access' });
    expect('field_updates' in updateIntent).toBe(false);

    const signature = base64UrlToBytes(body.intent_signature as string);
    expect(mlDsa44Verify(deviceSubCard.publicKey, canonicalize(updateIntent), signature)).toBe(true);
  });

  it("app-initiated (code 811, signed by the app's installation card) succeeds", async () => {
    const { transport, calls } = makeStubPress();
    const appCard = mlDsa44GenerateKeypair();
    const updater = {
      cardPointer: 'app-installation-card-pointer',
      sign: (message: Uint8Array) => mlDsa44Sign(appCard.secretKey, message),
    };

    const result = await revokeSubCard({
      transport,
      pressBaseUrl: PRESS_BASE_URL,
      targetSubCard: TARGET_SUB_CARD,
      updater,
      code: 811,
      notifyHolder: false,
    });

    expect(result).toEqual({ logEntryCid: 'log-entry-cid', newLogHeadCid: 'new-log-head-cid' });
    const updateIntent = calls[0]!.body.update_intent as Record<string, unknown>;
    expect(updateIntent.updater_card).toBe('app-installation-card-pointer');
    expect(updateIntent.code).toBe(811);
    expect(updateIntent.notify_holder).toBe(false);

    const signature = base64UrlToBytes(calls[0]!.body.intent_signature as string);
    expect(mlDsa44Verify(appCard.publicKey, canonicalize(updateIntent), signature)).toBe(true);
  });

  it('rejects a 9xx code at runtime before any network call, even if a caller bypasses the type system', async () => {
    const { transport, calls } = makeStubPress();
    const keypair = mlDsa44GenerateKeypair();

    await expect(
      revokeSubCard({
        transport,
        pressBaseUrl: PRESS_BASE_URL,
        targetSubCard: TARGET_SUB_CARD,
        updater: { cardPointer: 'x', sign: (m) => mlDsa44Sign(keypair.secretKey, m) },
        // `as` cast required — SubCardRevocationCode's type (800 | 801 | 810 | 811)
        // has no 9xx member, so this is not reachable without bypassing TypeScript,
        // which is exactly the structural exclusion this test also confirms holds
        // at runtime.
        code: 900 as unknown as SubCardRevocationCode,
      })
    ).rejects.toThrow(/not a valid sub-card 8xx revocation code/);

    expect(transport.request).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });

  it('throws on a non-2xx response from the press', async () => {
    const keypair = mlDsa44GenerateKeypair();
    const transport: ObliviousProtocolTransport = {
      request: vi.fn(async () => jsonResponse(403, { error: 'not authorized' })),
    };

    await expect(
      revokeSubCard({
        transport,
        pressBaseUrl: PRESS_BASE_URL,
        targetSubCard: TARGET_SUB_CARD,
        updater: { cardPointer: 'x', sign: (m) => mlDsa44Sign(keypair.secretKey, m) },
        code: 801,
      })
    ).rejects.toThrow(/returned status 403/);
  });
});
