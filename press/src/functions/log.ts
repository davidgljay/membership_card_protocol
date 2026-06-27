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
import type { IpfsClient } from '../ipfs/client.js';
import type { RegistryClient } from '../chain/registry.js';
import { canonicalize, canonicalizeExcluding } from '../serialization.js';
import {
  mlDsa44Sign,
  mlDsa44PublicKeyFromPrivate,
  toBase64url,
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

export async function appendLogEntry(
  config: PressConfig,
  kv: KvStore,
  registry: RegistryClient,
  ipfs: IpfsClient,
  targetCardAddress: Hex,
  updateIntent: UpdateIntentPayload,
  intentSignature: { public_key: string; signature: string }
): Promise<LogEntryResult> {
  // 1. Fetch current log head.
  const cardEntry = await registry.getCardEntry(targetCardAddress);
  const prevLogCid = new TextDecoder().decode(cardEntry.log_head_cid);
  const version = 1; // Increment logic requires full chain walk; placeholder for Phase 3.

  // 2. Assemble LogEntry.
  const entryType = updateIntent.code >= 800 ? 'revocation' : 'field_update';
  const logEntry: Record<string, unknown> = {
    version,
    code: updateIntent.code,
    entry_type: entryType,
    prev_log_root: prevLogCid,
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

  // 4. Pin to IPFS.
  const logBytes = canonicalize(signedEntry);
  const logEntryCid = await ipfs.pinToIPFS(logBytes);

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
  ipfs: IpfsClient,
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
