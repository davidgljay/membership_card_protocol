/**
 * Press log management (press.md §5.5).
 *
 * getLogHead        — KV-first, falls back to on-chain.
 * appendLogEntry    — build LogEntry, sign, pin to IPFS, update on-chain head.
 * appendIssuanceRecord — send PressIssuanceRecord to policy auditors.
 */

import type { PressConfig } from '../config.js';
import type { KvStore, LogHeadRecord } from '../kv.js';
import { kvKeys } from '../kv.js';
import type { IpfsPinningProvider } from '../ipfs/provider.js';
import type { RegistryClient } from '../chain/registry.js';
import { canonicalize, canonicalizeExcluding } from '../serialization.js';
import {
  mlDsa44Sign,
  mlDsa44PublicKeyFromPrivate,
  toBase64url,
  deriveContentKey,
  aes256gcmEncrypt,
  aes256gcmDecrypt,
} from './crypto.js';
import type { UpdateIntentPayload } from '../types.js';
import type { Hex } from 'viem';

// ---------------------------------------------------------------------------
// getLogHead (press.md §5.5)
// ---------------------------------------------------------------------------

export async function getLogHead(
  kv: KvStore,
  registry: RegistryClient,
  policyCid: string,
  policyAddress: Hex
): Promise<{ log_head_cid: string; seq: number }> {
  // KV-first per spec §5.5 step 1.
  const cached = await kv.getItem<LogHeadRecord>(kvKeys.logHead(policyCid));
  if (cached) {
    return { log_head_cid: cached.log_head_cid, seq: cached.seq };
  }

  // Fall back to on-chain.
  const entry = await registry.getCardEntry(policyAddress);
  const cid = new TextDecoder().decode(entry.log_head_cid);
  return { log_head_cid: cid, seq: 0 };
}

async function setLogHead(
  kv: KvStore,
  policyCid: string,
  logHeadCid: string,
  seq: number
): Promise<void> {
  await kv.setItem<LogHeadRecord>(kvKeys.logHead(policyCid), {
    log_head_cid: logHeadCid,
    seq,
    updated_at: Math.floor(Date.now() / 1000),
  });
}

// ---------------------------------------------------------------------------
// appendLogEntry (press.md §5.3)
// ---------------------------------------------------------------------------

export interface LogEntryResult {
  log_entry_cid: string;
  new_log_head_cid: string;
}

const SIGNATURE_FIELDS = ['issuer_signature', 'holder_signature', 'press_signature'];

export interface CurrentHead {
  /** The card's complete current field state (protocol-objects.md §3 `card_state`). */
  state: Record<string, unknown>;
  /** CIDs of every object before the head, oldest first (the head's own `history`). */
  history: string[];
  /** The head's `version` — 0 for a genesis CardDocument. */
  version: number;
}

/**
 * Reads and decrypts a card's current head with its content key. A genesis
 * CardDocument's state is the document minus its three signatures; a
 * LogEntry's state is its `card_state`.
 */
export async function readCurrentHead(
  ipfs: IpfsPinningProvider,
  headCid: string,
  contentKey: Uint8Array
): Promise<CurrentHead> {
  const head = JSON.parse(
    new TextDecoder().decode(await aes256gcmDecrypt(contentKey, await ipfs.fetchFromIPFS(headCid)))
  ) as Record<string, unknown>;
  const isLogEntry = head['entry_type'] === 'field_update' || head['entry_type'] === 'revocation';
  if (isLogEntry) {
    return {
      state: { ...((head['card_state'] as Record<string, unknown>) ?? {}) },
      history: Array.isArray(head['history']) ? (head['history'] as string[]) : [],
      version: typeof head['version'] === 'number' ? head['version'] : 0,
    };
  }
  const state = { ...head };
  for (const f of SIGNATURE_FIELDS) delete state[f];
  return { state, history: [], version: 0 };
}

/**
 * press.md §5.3 appendLogEntry / card_updates.md step 9: builds the complete
 * LogEntry (version, history, card_state), signs it, encrypts it under the
 * target card's content key (ADR-006, the same scheme as genesis documents),
 * pins it, and moves the on-chain head.
 */
export async function appendLogEntry(
  config: PressConfig,
  kv: KvStore,
  registry: RegistryClient,
  ipfs: IpfsPinningProvider,
  targetCardAddress: Hex,
  updateIntent: UpdateIntentPayload,
  intentSignature: { public_key: string; signature: string },
  targetPubkey: Uint8Array
): Promise<LogEntryResult> {
  // 1. Read the current head.
  const cardEntry = await registry.getCardEntry(targetCardAddress);
  const prevLogCid = new TextDecoder().decode(cardEntry.log_head_cid);
  const contentKey = deriveContentKey(targetPubkey);
  const current = await readCurrentHead(ipfs, prevLogCid, contentKey);

  // 2. Assemble the LogEntry.
  const entryType = updateIntent.code >= 800 ? 'revocation' : 'field_update';
  const cardState = { ...current.state };
  if (entryType === 'field_update') {
    for (const u of updateIntent.field_updates ?? []) cardState[u.field] = u.value;
  }
  const logEntry: Record<string, unknown> = {
    version: current.version + 1,
    code: updateIntent.code,
    entry_type: entryType,
    prev_log_root: prevLogCid,
    history: [...current.history, prevLogCid],
    card_state: cardState,
    notify_holder: updateIntent.notify_holder ?? false,
    intent_signature: intentSignature,
  };
  if (entryType === 'field_update' && updateIntent.field_updates) {
    logEntry['field_updates'] = updateIntent.field_updates;
  }
  if (entryType === 'revocation' && updateIntent.revocation) {
    logEntry['revocation'] = updateIntent.revocation;
  }
  if (updateIntent.updater_message) {
    logEntry['updater_message'] = updateIntent.updater_message;
  }

  // 3. Sign excluding press_signature.
  const toSign = canonicalizeExcluding(logEntry, ['press_signature']);
  const sig = mlDsa44Sign(config.PRESS_MLDSA44_PRIVATE_KEY, toSign);
  const pubKey = mlDsa44PublicKeyFromPrivate(config.PRESS_MLDSA44_PRIVATE_KEY);
  const signedEntry = {
    ...logEntry,
    press_signature: {
      public_key: toBase64url(pubKey),
      signature: toBase64url(sig),
    },
  };

  // 4. Encrypt and pin.
  const ciphertext = await aes256gcmEncrypt(contentKey, canonicalize(signedEntry));
  const logEntryCid = await ipfs.pinToIPFS(ciphertext);

  // 5. Update on-chain head.
  await registry.updateCardHead({
    cardAddress: targetCardAddress,
    prevLogCid: cardEntry.log_head_cid,
    newLogCid: new TextEncoder().encode(logEntryCid),
  });

  return { log_entry_cid: logEntryCid, new_log_head_cid: logEntryCid };
}

// ---------------------------------------------------------------------------
// appendIssuanceRecord (press.md §5.5)
// ---------------------------------------------------------------------------

export interface IssuanceRecordResult {
  confirmed_auditors: string[];
  timed_out_auditors: string[];
}

const AUDITOR_TIMEOUT_MS = 30_000;

export async function appendIssuanceRecord(
  config: PressConfig,
  ipfs: IpfsPinningProvider,
  policyCid: string,
  cardCid: string,
  recipientPubkey: string,
  scipCid: string,
  offerType: 'targeted' | 'open'
): Promise<IssuanceRecordResult> {
  // 1. Resolve policy card to get auditor list.
  let policyBytes: Uint8Array;
  try {
    policyBytes = await ipfs.fetchFromIPFS(policyCid);
  } catch {
    return { confirmed_auditors: [], timed_out_auditors: [] };
  }

  const policy = JSON.parse(new TextDecoder().decode(policyBytes)) as {
    auditors?: string[];
    admin_wallet_service_url?: string;
  };

  if (!policy.auditors || policy.auditors.length === 0) {
    return { confirmed_auditors: [], timed_out_auditors: [] };
  }

  // 2. Assemble PressIssuanceRecord.
  const record = {
    card_cid: cardCid,
    recipient_pubkey: recipientPubkey,
    scip_cid: scipCid,
    issued_at: new Date().toISOString(),
    offer_type: offerType,
  };

  const confirmed: string[] = [];
  const timedOut: string[] = [];

  // 3. Send to each auditor via their wallet service endpoint.
  // Phase 3: sends the record as plaintext JSON. Full E2E encryption to auditor
  // pubkeys (via the message routing layer) is a Phase 4 enhancement.
  await Promise.all(
    policy.auditors.map(async (auditorAddress) => {
      try {
        // Resolve auditor's wallet service endpoint from their card's IPFS document.
        // For Phase 3: use a convention that the auditor_address is also the endpoint URL stub.
        // Real implementation requires fetching the auditor's CardDocument.
        const endpoint = `${auditorAddress}/notify-issuance`;
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), AUDITOR_TIMEOUT_MS);

        try {
          const res = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(record),
            signal: controller.signal,
          });
          clearTimeout(timeout);
          if (res.ok) {
            confirmed.push(auditorAddress);
          } else {
            timedOut.push(auditorAddress);
            console.warn(`[press] Auditor ${auditorAddress} returned HTTP ${res.status}`);
          }
        } catch {
          clearTimeout(timeout);
          timedOut.push(auditorAddress);
          console.warn(`[press] Auditor ${auditorAddress} timed out or unreachable`);
        }
      } catch (err) {
        timedOut.push(auditorAddress);
        console.warn(`[press] Failed to notify auditor ${auditorAddress}: ${String(err)}`);
      }
    })
  );

  return { confirmed_auditors: confirmed, timed_out_auditors: timedOut };
}
