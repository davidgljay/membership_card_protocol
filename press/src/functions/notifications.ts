/**
 * Sibling sub-card notifications (`object_specs/press.md` §5.4 "Notification:
 * Sibling subcard alert"; `messaging_protocol.md` §9–11).
 *
 * When a code-510/511/512 `active_subcards` directory update is accepted,
 * the press alerts the holder's *other* sub-cards so a compromised holder
 * key that silently adds/removes/rotates a sub-card can be detected by the
 * legitimate devices still listed in the directory.
 *
 * **Phase 3 delivery note (matches the existing `appendIssuanceRecord`
 * auditor-notification precedent in `log.ts`):** full E2E encryption of
 * this content to each sub-card's ML-KEM-768 public key (per ADR-007) is
 * not implemented here — there is currently no field anywhere in this
 * protocol (`SubCardDocument`, on-chain `SubCardEntry`, or elsewhere) that
 * records a sub-card's ML-KEM public key for the press to resolve, so an
 * E2E-encrypted implementation has no data to encrypt *to* yet. This mirrors
 * `appendIssuanceRecord`'s auditor notifications, which are sent as plaintext
 * JSON to a per-card endpoint stub with the same caveat. Delivery here is
 * therefore best-effort, non-blocking (never fails the update itself), and
 * plaintext, pending the ML-KEM key-resolution mechanism referenced in
 * `plans/milestones/subcard-registry-final-summary.md` "Next Steps" #4.
 */

import { keccak256, fromBase64url } from './crypto.js';

export type SubcardSiblingNotificationType =
  | 'subcard_sibling_added'
  | 'subcard_sibling_removed'
  | 'subcard_sibling_rotated';

export interface SubcardSiblingAddedContent {
  master_card: string;
  new_pubkey: string;
  log_entry_cid: string;
  timestamp: string;
}

export interface SubcardSiblingRemovedContent {
  master_card: string;
  removed_pubkey: string;
  log_entry_cid: string;
  timestamp: string;
}

export interface SubcardSiblingRotatedContent {
  master_card: string;
  old_pubkey: string;
  new_pubkey: string;
  log_entry_cid: string;
  timestamp: string;
}

export function buildSubcardSiblingAddedContent(
  masterCardPointer: string,
  newPubkey: string,
  logEntryCid: string,
  timestamp: string
): SubcardSiblingAddedContent {
  return { master_card: masterCardPointer, new_pubkey: newPubkey, log_entry_cid: logEntryCid, timestamp };
}

export function buildSubcardSiblingRemovedContent(
  masterCardPointer: string,
  removedPubkey: string,
  logEntryCid: string,
  timestamp: string
): SubcardSiblingRemovedContent {
  return { master_card: masterCardPointer, removed_pubkey: removedPubkey, log_entry_cid: logEntryCid, timestamp };
}

export function buildSubcardSiblingRotatedContent(
  masterCardPointer: string,
  oldPubkey: string,
  newPubkey: string,
  logEntryCid: string,
  timestamp: string
): SubcardSiblingRotatedContent {
  return { master_card: masterCardPointer, old_pubkey: oldPubkey, new_pubkey: newPubkey, log_entry_cid: logEntryCid, timestamp };
}

// ---------------------------------------------------------------------------
// Diffing: derive what changed and who the (non-changed) recipients are
// ---------------------------------------------------------------------------

export interface ActiveSubcardsDiffAdded {
  code: 510;
  newPubkey: string;
  /** Recipients per spec: all subcards present *before* the addition — not including the new one. */
  recipients: string[];
}

export interface ActiveSubcardsDiffRemoved {
  code: 511;
  removedPubkey: string;
  /** Recipients per spec: all subcards remaining after the removal. */
  recipients: string[];
}

export interface ActiveSubcardsDiffRotated {
  code: 512;
  oldPubkey: string;
  newPubkey: string;
  /** Recipients per spec: all subcards remaining after the rotation. */
  recipients: string[];
}

export type ActiveSubcardsDiff = ActiveSubcardsDiffAdded | ActiveSubcardsDiffRemoved | ActiveSubcardsDiffRotated;

/**
 * Diff the pre- and post-update `active_subcards` arrays (base64url pubkeys)
 * to determine which single pubkey changed and who the notification
 * recipients are. Returns `null` if the diff doesn't match the shape a
 * well-formed code-510/511/512 update should produce (e.g. more than one
 * entry changed) — callers should skip notification rather than guess.
 */
export function diffActiveSubcards(
  code: 510 | 511 | 512,
  before: string[],
  after: string[]
): ActiveSubcardsDiff | null {
  const beforeSet = new Set(before);
  const afterSet = new Set(after);
  const added = after.filter((pk) => !beforeSet.has(pk));
  const removed = before.filter((pk) => !afterSet.has(pk));

  if (code === 510) {
    if (added.length !== 1 || removed.length !== 0) return null;
    return { code, newPubkey: added[0]!, recipients: before };
  }
  if (code === 511) {
    if (removed.length !== 1 || added.length !== 0) return null;
    return { code, removedPubkey: removed[0]!, recipients: after };
  }
  // code 512 (rotation): exactly one swapped for exactly one other.
  if (added.length !== 1 || removed.length !== 1) return null;
  return { code, oldPubkey: removed[0]!, newPubkey: added[0]!, recipients: after };
}

// ---------------------------------------------------------------------------
// Dispatch (best-effort, per-recipient isolated failure — see module doc)
// ---------------------------------------------------------------------------

export interface NotifySubcardSiblingsResult {
  notified: string[];
  failed: string[];
}

const NOTIFY_TIMEOUT_MS = 30_000;

/**
 * Best-effort notification of each recipient sub-card. `recipientPubkeysB64`
 * are base64url ML-DSA-44 public keys (as stored in `active_subcards`); each
 * is converted to its registry address (`keccak256(pubkey)`) to build the
 * (stub) notification endpoint, matching `appendIssuanceRecord`'s auditor
 * convention. Never throws — a notification failure must not block the
 * `active_subcards` update itself.
 */
export async function notifySubcardSiblings(
  type: SubcardSiblingNotificationType,
  recipientPubkeysB64: string[],
  content: SubcardSiblingAddedContent | SubcardSiblingRemovedContent | SubcardSiblingRotatedContent
): Promise<NotifySubcardSiblingsResult> {
  const notified: string[] = [];
  const failed: string[] = [];

  await Promise.all(
    recipientPubkeysB64.map(async (pubkeyB64) => {
      let address: string;
      try {
        address = '0x' + Buffer.from(keccak256(fromBase64url(pubkeyB64))).toString('hex');
      } catch (err) {
        console.warn(`[press] Skipping malformed active_subcards entry during ${type} notification: ${String(err)}`);
        return;
      }

      const endpoint = `${address}/notify`;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), NOTIFY_TIMEOUT_MS);
      try {
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type, content }),
          signal: controller.signal,
        });
        clearTimeout(timeout);
        if (res.ok) {
          notified.push(address);
        } else {
          failed.push(address);
          console.warn(`[press] Sub-card ${address} returned HTTP ${res.status} for ${type}`);
        }
      } catch (err) {
        clearTimeout(timeout);
        failed.push(address);
        console.warn(`[press] Sub-card ${address} unreachable for ${type}: ${String(err)}`);
      }
    })
  );

  return { notified, failed };
}
