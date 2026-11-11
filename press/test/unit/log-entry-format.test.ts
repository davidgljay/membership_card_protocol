/**
 * protocol-objects.md §3 LogEntry format, written by appendLogEntry and read
 * back by the verifier (decryptCardHead) — the round trip card login depends
 * on (code-510 active_subcards, code-520 domain_binding).
 */
import { describe, it, expect, vi } from 'vitest';
import { ml_dsa44 } from '@noble/post-quantum/ml-dsa.js';
import { decryptCardHead, hkdfSha3256Key } from './log-entry-helpers.js';
import { appendLogEntry } from '../../src/functions/log.js';
import { createMockProvider } from '../../src/ipfs/mock.js';
import { canonicalize } from '../../src/serialization.js';
import { toBase64url, deriveContentKey, aes256gcmEncrypt, aes256gcmDecrypt, keccak256 } from '../../src/functions/crypto.js';
import type { PressConfig } from '../../src/config.js';

const { secretKey: PRESS_SK } = ml_dsa44.keygen(new Uint8Array(32).fill(0x71));
const card = ml_dsa44.keygen(new Uint8Array(32).fill(0x72));
const CARD_ADDR = Buffer.from(keccak256(card.publicKey)).toString('hex');

describe('appendLogEntry writes protocol-objects.md §3 LogEntries', () => {
  it('two updates chain version/history/card_state, are encrypted, and the verifier reads the merged state', async () => {
    const ipfs = createMockProvider();
    const genesis = { policy_id: 'bafypolicy', recipient_pubkey: toBase64url(card.publicKey), ancestry_pubkeys: ['parent'], issuer_signature: 's1', holder_signature: 's2', press_signature: 's3' };
    const genesisCid = await ipfs.pinToIPFS(await aes256gcmEncrypt(deriveContentKey(card.publicKey), canonicalize(genesis)));
    let head = genesisCid;
    const registry = {
      getCardEntry: vi.fn().mockImplementation(async () => ({ exists: true, log_head_cid: new TextEncoder().encode(head) })),
      updateCardHead: vi.fn().mockImplementation(async ({ newLogCid }: { newLogCid: Uint8Array }) => {
        head = new TextDecoder().decode(newLogCid);
        return '0xtx';
      }),
    };
    const config = { PRESS_MLDSA44_PRIVATE_KEY: PRESS_SK } as unknown as PressConfig;
    const sig = { public_key: toBase64url(card.publicKey), signature: 'x' };

    const first = await appendLogEntry(config, {} as never, registry as never, ipfs, CARD_ADDR as never,
      { updater_card_address: CARD_ADDR, target_card_address: CARD_ADDR, code: 510, timestamp: '2026-11-09T00:00:00Z', field_updates: [{ field: 'active_subcards', value: ['server-pk'] }] },
      sig, card.publicKey);
    const second = await appendLogEntry(config, {} as never, registry as never, ipfs, CARD_ADDR as never,
      { updater_card_address: CARD_ADDR, target_card_address: CARD_ADDR, code: 520, timestamp: '2026-11-09T00:01:00Z', field_updates: [{ field: 'domain_binding', value: { domain: 'example.org' } }] },
      sig, card.publicKey);

    // Encrypted: the raw bytes are not JSON.
    const raw = await ipfs.fetchFromIPFS(second.log_entry_cid);
    expect(() => JSON.parse(new TextDecoder().decode(raw))).toThrow();

    // Entry shape per §3.
    const entry = JSON.parse(new TextDecoder().decode(await aes256gcmDecrypt(deriveContentKey(card.publicKey), raw)));
    expect(entry).toMatchObject({
      version: 2,
      code: 520,
      entry_type: 'field_update',
      prev_log_root: first.log_entry_cid,
      history: [genesisCid, first.log_entry_cid],
      card_state: { active_subcards: ['server-pk'], domain_binding: { domain: 'example.org' }, policy_id: 'bafypolicy' },
    });
    expect(entry.card_state.issuer_signature).toBeUndefined();
    expect(entry.press_signature.signature).toBeTruthy();

    // The verifier's reader sees the merged current state.
    const fields = await decryptCardHead(second.log_entry_cid, hkdfSha3256Key(card.publicKey), { fetch: (cid: string) => ipfs.fetchFromIPFS(cid) });
    expect(fields).toMatchObject({ active_subcards: ['server-pk'], domain_binding: { domain: 'example.org' }, ancestry_pubkeys: ['parent'], recipient_pubkey: toBase64url(card.publicKey) });
  });
});
