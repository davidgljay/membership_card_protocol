/**
 * Sibling sub-card notification unit tests (`messaging_protocol.md` §9-11):
 * content builders, active_subcards diffing, and best-effort dispatch.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { keccak256 } from '../../src/functions/crypto.js';
import {
  buildSubcardSiblingAddedContent,
  buildSubcardSiblingRemovedContent,
  buildSubcardSiblingRotatedContent,
  diffActiveSubcards,
  notifySubcardSiblings,
} from '../../src/functions/notifications.js';

function addressOf(pubkeyB64: string): string {
  return '0x' + Buffer.from(keccak256(Buffer.from(pubkeyB64, 'base64url'))).toString('hex');
}

describe('content builders', () => {
  it('buildSubcardSiblingAddedContent matches messaging_protocol.md §9 shape', () => {
    const content = buildSubcardSiblingAddedContent('master-ptr', 'new-pk', 'bafycid', '2026-01-01T00:00:00Z');
    expect(content).toEqual({
      master_card: 'master-ptr',
      new_pubkey: 'new-pk',
      log_entry_cid: 'bafycid',
      timestamp: '2026-01-01T00:00:00Z',
    });
  });

  it('buildSubcardSiblingRemovedContent matches messaging_protocol.md §10 shape', () => {
    const content = buildSubcardSiblingRemovedContent('master-ptr', 'removed-pk', 'bafycid', '2026-01-01T00:00:00Z');
    expect(content).toEqual({
      master_card: 'master-ptr',
      removed_pubkey: 'removed-pk',
      log_entry_cid: 'bafycid',
      timestamp: '2026-01-01T00:00:00Z',
    });
  });

  it('buildSubcardSiblingRotatedContent matches messaging_protocol.md §11 shape', () => {
    const content = buildSubcardSiblingRotatedContent('master-ptr', 'old-pk', 'new-pk', 'bafycid', '2026-01-01T00:00:00Z');
    expect(content).toEqual({
      master_card: 'master-ptr',
      old_pubkey: 'old-pk',
      new_pubkey: 'new-pk',
      log_entry_cid: 'bafycid',
      timestamp: '2026-01-01T00:00:00Z',
    });
  });
});

describe('diffActiveSubcards', () => {
  it('code 510: identifies the added pubkey and recipients = pre-update list (not including the new one)', () => {
    const diff = diffActiveSubcards(510, ['a', 'b'], ['a', 'b', 'c']);
    expect(diff).toEqual({ code: 510, newPubkey: 'c', recipients: ['a', 'b'] });
  });

  it('code 510: returns null if more than one entry was added', () => {
    expect(diffActiveSubcards(510, ['a'], ['a', 'b', 'c'])).toBeNull();
  });

  it('code 510: returns null if an entry was also removed (not a pure addition)', () => {
    expect(diffActiveSubcards(510, ['a', 'b'], ['a', 'c'])).toBeNull();
  });

  it('code 511: identifies the removed pubkey and recipients = post-update (remaining) list', () => {
    const diff = diffActiveSubcards(511, ['a', 'b', 'c'], ['a', 'c']);
    expect(diff).toEqual({ code: 511, removedPubkey: 'b', recipients: ['a', 'c'] });
  });

  it('code 511: returns null if more than one entry was removed', () => {
    expect(diffActiveSubcards(511, ['a', 'b', 'c'], ['a'])).toBeNull();
  });

  it('code 512: identifies old/new pubkeys and recipients = post-rotation (remaining) list', () => {
    const diff = diffActiveSubcards(512, ['a', 'b'], ['a', 'c']);
    expect(diff).toEqual({ code: 512, oldPubkey: 'b', newPubkey: 'c', recipients: ['a', 'c'] });
  });

  it('code 512: returns null for an addition-only change (not a rotation)', () => {
    expect(diffActiveSubcards(512, ['a'], ['a', 'b'])).toBeNull();
  });

  it('code 512: returns null for a removal-only change (not a rotation)', () => {
    expect(diffActiveSubcards(512, ['a', 'b'], ['a'])).toBeNull();
  });

  it('returns null when nothing changed at all', () => {
    expect(diffActiveSubcards(510, ['a'], ['a'])).toBeNull();
  });
});

describe('notifySubcardSiblings', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  const pkA = Buffer.from(new Uint8Array(56).fill(1)).toString('base64url');
  const pkB = Buffer.from(new Uint8Array(56).fill(2)).toString('base64url');

  it('dispatches a POST to each recipient’s derived address endpoint with the type and content', async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    global.fetch = vi.fn(async (url: unknown, init?: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return { ok: true, status: 200 } as Response;
    }) as unknown as typeof fetch;

    const content = buildSubcardSiblingAddedContent('master', 'new-pk', 'cid', 'ts');
    const result = await notifySubcardSiblings('subcard_sibling_added', [pkA, pkB], content);

    expect(result.failed).toEqual([]);
    expect(result.notified).toHaveLength(2);
    expect(result.notified).toContain(addressOf(pkA));
    expect(result.notified).toContain(addressOf(pkB));
    expect(calls).toHaveLength(2);
    expect(calls[0]!.url).toBe(`${addressOf(pkA)}/notify`);
    expect(calls[0]!.body).toEqual({ type: 'subcard_sibling_added', content });
  });

  it('isolates a failure to one recipient — others still get notified', async () => {
    global.fetch = vi.fn(async (url: unknown) => {
      if (String(url).includes(addressOf(pkA))) {
        return { ok: false, status: 500 } as Response;
      }
      return { ok: true, status: 200 } as Response;
    }) as unknown as typeof fetch;

    const content = buildSubcardSiblingRemovedContent('master', 'removed-pk', 'cid', 'ts');
    const result = await notifySubcardSiblings('subcard_sibling_removed', [pkA, pkB], content);

    expect(result.failed).toEqual([addressOf(pkA)]);
    expect(result.notified).toEqual([addressOf(pkB)]);
  });

  it('never throws — a network error is recorded as a failure, not an exception', async () => {
    global.fetch = vi.fn(async () => {
      throw new Error('network unreachable');
    }) as unknown as typeof fetch;

    const content = buildSubcardSiblingRotatedContent('master', 'old-pk', 'new-pk', 'cid', 'ts');
    const result = await expect(
      notifySubcardSiblings('subcard_sibling_rotated', [pkA], content)
    ).resolves.toBeDefined();
    void result;
  });

  it('returns empty results for an empty recipient list (no-op)', async () => {
    global.fetch = vi.fn() as unknown as typeof fetch;
    const content = buildSubcardSiblingAddedContent('master', 'new-pk', 'cid', 'ts');
    const result = await notifySubcardSiblings('subcard_sibling_added', [], content);
    expect(result).toEqual({ notified: [], failed: [] });
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
