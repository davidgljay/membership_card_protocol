/**
 * handleUpdate — holder-only authorization for codes 510/511/512
 * (`active_subcards` directory updates), per `process_specs/card_updates.md`
 * "Sub-Card Directory Updates" and `protocol-objects.md §1.1`.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { ml_dsa44 } from '@noble/post-quantum/ml-dsa.js';
import { keccak_256 } from '@noble/hashes/sha3';
import { handleUpdate } from '../../src/handlers/update.js';
import { canonicalize } from '../../src/serialization.js';
import { toBase64url, deriveContentKey, aes256gcmEncrypt, keccak256 } from '../../src/functions/crypto.js';
import type { PressContext } from '../../src/context.js';
import type { PressConfig } from '../../src/config.js';
import type { UpdateIntentPayload, UpdateRequest } from '../../src/types.js';

// Unprefixed — matches handlers/update.ts's binding-check convention
// (wallet-sdk's `offerVerification.ts` compares the same way).
const holderSeed = new Uint8Array(32).fill(0x44);
const { secretKey: HOLDER_SK, publicKey: HOLDER_PK } = ml_dsa44.keygen(holderSeed);
const HOLDER_ADDRESS = Buffer.from(keccak_256(HOLDER_PK)).toString('hex');

const otherSeed = new Uint8Array(32).fill(0x55);
const { secretKey: OTHER_SK, publicKey: OTHER_PK } = ml_dsa44.keygen(otherSeed);
const OTHER_ADDRESS = Buffer.from(keccak_256(OTHER_PK)).toString('hex');

const CONFIG = {
  STALENESS_WINDOW_SECONDS: 300,
  PRESS_POLICY_CIDS: ['bafybeipolicy'],
  PRESS_CARD_CID: 'bafybeipress',
  PRESS_MLDSA44_PRIVATE_KEY: HOLDER_SK, // stand-in; only used by appendLogEntry's press signature
} as unknown as PressConfig;

function makeCtx(overrides?: Partial<PressContext>): PressContext {
  const registry = {
    getCardEntry: vi.fn().mockResolvedValue({
      log_head_cid: new TextEncoder().encode('bafybeiprevhead'),
      policy_address: '0xpolicy',
      last_press_address: '0xpress',
      forward_to: '0x' + '00'.repeat(32),
      exists: true,
    }),
    updateCardHead: vi.fn().mockResolvedValue('0xtxhash'),
  };
  const ipfs = {
    pinToIPFS: vi.fn().mockResolvedValue('bafybeinewentry'),
    fetchFromIPFS: vi.fn().mockRejectedValue(new Error('not used in this test')),
  };
  const kv = {
    getItem: vi.fn().mockResolvedValue(null),
    setItem: vi.fn().mockResolvedValue(undefined),
    increment: vi.fn().mockResolvedValue(1),
  };
  return {
    config: CONFIG,
    kv,
    verifier: { verifyCard: vi.fn() },
    registry,
    ipfs,
    gas: {} as PressContext['gas'],
    pressPublicKey: HOLDER_PK,
    pressAddress: HOLDER_ADDRESS,
    ...overrides,
  } as unknown as PressContext;
}

function signIntent(intent: UpdateIntentPayload, secretKey: Uint8Array, publicKey: Uint8Array) {
  const message = canonicalize(intent as unknown as Record<string, unknown>);
  const signature = ml_dsa44.sign(message, secretKey);
  return {
    update_intent: intent,
    intent_signature: {
      public_key: toBase64url(publicKey),
      signature: toBase64url(signature),
    },
  } satisfies UpdateRequest;
}

function baseIntent(code: number, overrides?: Partial<UpdateIntentPayload>): UpdateIntentPayload {
  return {
    updater_card_address: HOLDER_ADDRESS,
    target_card_address: HOLDER_ADDRESS,
    code,
    timestamp: new Date().toISOString(),
    field_updates: [{ field: 'active_subcards', value: ['dummy-pubkey'] }],
    notify_holder: true,
    ...overrides,
  };
}

describe('handleUpdate — active_subcards directory codes (510/511/512)', () => {
  it.each([510, 511, 512])(
    'accepts a code-%d intent signed by the target card’s own holder key',
    async (code) => {
      const ctx = makeCtx();
      const intent = baseIntent(code);
      const request = signIntent(intent, HOLDER_SK, HOLDER_PK);

      const result = await handleUpdate(ctx, request);
      expect(result).toEqual({ log_entry_cid: 'bafybeinewentry', new_log_head_cid: 'bafybeinewentry' });
    }
  );

  it.each([510, 511, 512])(
    'rejects a code-%d intent where updater_card_address differs from target_card_address (P-23)',
    async (code) => {
      const ctx = makeCtx();
      const intent = baseIntent(code, { updater_card_address: OTHER_ADDRESS });
      // Signed correctly by "other," but other is not the target — must still be rejected.
      const request = signIntent(intent, OTHER_SK, OTHER_PK);

      await expect(handleUpdate(ctx, request)).rejects.toMatchObject({ pressCode: 'P-23' });
    }
  );

  it.each([510, 511, 512])(
    'rejects a code-%d intent claiming updater === target but signed by a different key (P-13)',
    async (code) => {
      const ctx = makeCtx();
      // updater_card_address/target_card_address both claim to be the holder's card,
      // but the intent is actually signed by an unrelated keypair — the pubkey-to-address
      // binding check must catch this even though the address fields match.
      const intent = baseIntent(code);
      const request = signIntent(intent, OTHER_SK, OTHER_PK);

      await expect(handleUpdate(ctx, request)).rejects.toMatchObject({ pressCode: 'P-13' });
    }
  );

  it('does not allow an issuer/other card to add itself as an active sub-card on someone else’s master card', async () => {
    const ctx = makeCtx();
    // Attacker (OTHER) tries to submit a code-510 intent targeting the holder's card,
    // signed with their own key, claiming to be the updater — this must fail at the
    // updater===target check before any signature-binding nuance even matters.
    const intent = baseIntent(510, {
      target_card_address: HOLDER_ADDRESS,
      updater_card_address: OTHER_ADDRESS,
    });
    const request = signIntent(intent, OTHER_SK, OTHER_PK);

    await expect(handleUpdate(ctx, request)).rejects.toMatchObject({ pressCode: 'P-23' });
  });

  it('does not fall through to the generic chain-validity/update_policy check for 510/511/512', async () => {
    const ctx = makeCtx();
    // verifier.verifyCard would normally gate 1xx-7xx codes; for 510/511/512 it must
    // never be consulted, since authorization is hardcoded to the holder-key binding check.
    const verifyCard = vi.fn();
    const ctxWithSpy = makeCtx({ verifier: { verifyCard } as unknown as PressContext['verifier'] });
    const intent = baseIntent(510);
    const request = signIntent(intent, HOLDER_SK, HOLDER_PK);

    await handleUpdate(ctxWithSpy, request);
    expect(verifyCard).not.toHaveBeenCalled();
  });
});

describe('handleUpdate — sibling sub-card notification dispatch', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  function addressOf(pubkeyB64: string): string {
    return '0x' + Buffer.from(keccak256(Buffer.from(pubkeyB64, 'base64url'))).toString('hex');
  }

  /** Encrypt a minimal CardDocument the way the press's ADR-006 scheme does, so
   * handleUpdate's pre-update decrypt (deriveContentKey(HOLDER_PK) + AES-GCM)
   * succeeds exactly as it would against a real master card on IPFS. */
  function encryptMasterDoc(activeSubcards: string[]): Promise<Uint8Array> {
    const doc = { active_subcards: activeSubcards };
    const key = deriveContentKey(HOLDER_PK);
    return aes256gcmEncrypt(key, new TextEncoder().encode(JSON.stringify(doc)));
  }

  it('sends subcard_sibling_added to the pre-existing siblings (not the new one) on a code-510 add', async () => {
    const existingA = Buffer.from(new Uint8Array(56).fill(10)).toString('base64url');
    const existingB = Buffer.from(new Uint8Array(56).fill(20)).toString('base64url');
    const newSub = Buffer.from(new Uint8Array(56).fill(30)).toString('base64url');

    const ctx = makeCtx({
      ipfs: {
        fetchFromIPFS: vi.fn().mockResolvedValue(await encryptMasterDoc([existingA, existingB])),
        pinToIPFS: vi.fn().mockResolvedValue('bafybeinewentry'),
      } as unknown as PressContext['ipfs'],
    });

    const calls: string[] = [];
    global.fetch = vi.fn(async (url: unknown) => {
      calls.push(String(url));
      return { ok: true, status: 200 } as Response;
    }) as unknown as typeof fetch;

    const intent = baseIntent(510, {
      field_updates: [{ field: 'active_subcards', value: [existingA, existingB, newSub] }],
    });
    await handleUpdate(ctx, signIntent(intent, HOLDER_SK, HOLDER_PK));

    expect(calls).toHaveLength(2);
    expect(calls).toContain(`${addressOf(existingA)}/notify`);
    expect(calls).toContain(`${addressOf(existingB)}/notify`);
    expect(calls).not.toContain(`${addressOf(newSub)}/notify`);
  });

  it('sends subcard_sibling_removed to remaining siblings, with the removed pubkey in content', async () => {
    const remaining = Buffer.from(new Uint8Array(56).fill(11)).toString('base64url');
    const removed = Buffer.from(new Uint8Array(56).fill(22)).toString('base64url');

    const ctx = makeCtx({
      ipfs: {
        fetchFromIPFS: vi.fn().mockResolvedValue(await encryptMasterDoc([remaining, removed])),
        pinToIPFS: vi.fn().mockResolvedValue('bafybeinewentry'),
      } as unknown as PressContext['ipfs'],
    });

    let capturedBody: Record<string, unknown> | undefined;
    global.fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      capturedBody = JSON.parse(String(init?.body));
      return { ok: true, status: 200 } as Response;
    }) as unknown as typeof fetch;

    const intent = baseIntent(511, {
      field_updates: [{ field: 'active_subcards', value: [remaining] }],
    });
    await handleUpdate(ctx, signIntent(intent, HOLDER_SK, HOLDER_PK));

    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(global.fetch).toHaveBeenCalledWith(`${addressOf(remaining)}/notify`, expect.anything());
    expect(capturedBody).toMatchObject({
      type: 'subcard_sibling_removed',
      content: { removed_pubkey: removed },
    });
  });

  it('sends subcard_sibling_rotated to remaining siblings, with old/new pubkeys in content', async () => {
    const remaining = Buffer.from(new Uint8Array(56).fill(33)).toString('base64url');
    const oldSub = Buffer.from(new Uint8Array(56).fill(44)).toString('base64url');
    const newSub = Buffer.from(new Uint8Array(56).fill(55)).toString('base64url');

    const ctx = makeCtx({
      ipfs: {
        fetchFromIPFS: vi.fn().mockResolvedValue(await encryptMasterDoc([remaining, oldSub])),
        pinToIPFS: vi.fn().mockResolvedValue('bafybeinewentry'),
      } as unknown as PressContext['ipfs'],
    });

    const bodies: Record<string, unknown>[] = [];
    global.fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return { ok: true, status: 200 } as Response;
    }) as unknown as typeof fetch;

    const intent = baseIntent(512, {
      field_updates: [{ field: 'active_subcards', value: [remaining, newSub] }],
    });
    await handleUpdate(ctx, signIntent(intent, HOLDER_SK, HOLDER_PK));

    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(bodies[0]).toMatchObject({
      type: 'subcard_sibling_rotated',
      content: { old_pubkey: oldSub, new_pubkey: newSub },
    });
  });

  it('still returns a successful result even when notification dispatch throws', async () => {
    const ctx = makeCtx({
      ipfs: {
        fetchFromIPFS: vi.fn().mockResolvedValue(await encryptMasterDoc([])),
        pinToIPFS: vi.fn().mockResolvedValue('bafybeinewentry'),
      } as unknown as PressContext['ipfs'],
    });
    global.fetch = vi.fn().mockRejectedValue(new Error('network down')) as unknown as typeof fetch;

    const newSub = Buffer.from(new Uint8Array(56).fill(66)).toString('base64url');
    const intent = baseIntent(510, { field_updates: [{ field: 'active_subcards', value: [newSub] }] });
    const result = await handleUpdate(ctx, signIntent(intent, HOLDER_SK, HOLDER_PK));

    expect(result).toEqual({ log_entry_cid: 'bafybeinewentry', new_log_head_cid: 'bafybeinewentry' });
  });
});
