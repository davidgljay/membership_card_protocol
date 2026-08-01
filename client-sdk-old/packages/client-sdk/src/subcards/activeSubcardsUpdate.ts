import { canonicalize } from '../crypto/canonicalize.js';
import { bytesToBase64Url } from '../util/base64url.js';
import type { ObliviousProtocolTransport } from '../providers/ObliviousProtocolTransport.js';
import type { UpdateIntentSigner } from './revocation.js';

/**
 * Operations on a holder's `active_subcards` directory via update codes 510/511/512.
 *
 * These codes are hardcoded to holder-only authorization per `protocol-objects.md §1.1`
 * and `update_codes.md §5xx`: only the holder's own master card key may sign these
 * updates, regardless of the governing policy's `update_policy`. The holder is
 * simultaneously the updater and the target (the update is posted to their own card).
 *
 * Per `card_updates.md §Sub-Card Directory Updates`:
 * - Code 510 (addition): field_updates is [{ "field": "active_subcards", "value": <full new array with new pubkey appended> }]
 * - Code 511 (removal): field_updates is [{ "field": "active_subcards", "value": <full new array with removed pubkey deleted> }]
 * - Code 512 (rotation): field_updates is [{ "field": "active_subcards", "value": <full new array with one pubkey swapped> }] — atomic operation
 *
 * The operations below are high-level helpers; the caller must provide the full
 * updated `active_subcards` array (not just the added/removed/rotated entry).
 */

export interface UpdateActiveSubcardsOptions {
  transport: ObliviousProtocolTransport;
  /** Any press listed in the policy's `approved_presses`. */
  pressBaseUrl: string;
  /** The holder's own master card pointer (`target_card` and `updater_card` are identical). */
  holderCardPointer: string;
  /** The holder's signing identity (their own master card key). */
  holder: UpdateIntentSigner;
  /** Defaults to now. May predate posting, per `card_updates.md`. */
  effectiveDate?: string;
  /** Optional note explaining the change (e.g., "device registered", "app uninstalled", "key rotated"). */
  note?: string;
  /** Defaults to `true`. */
  notifyHolder?: boolean;
}

export interface AddActiveSubCardOptions extends UpdateActiveSubcardsOptions {
  /** The full new `active_subcards` array after the addition (must include the new pubkey). */
  newActiveSubcards: string[];
}

export interface RemoveActiveSubCardOptions extends UpdateActiveSubcardsOptions {
  /** The full new `active_subcards` array after the removal (must NOT include the removed pubkey). */
  newActiveSubcards: string[];
}

export interface RotateActiveSubCardOptions extends UpdateActiveSubcardsOptions {
  /** The full new `active_subcards` array after rotation (exactly one pubkey swapped for another). */
  newActiveSubcards: string[];
}

export interface UpdateSubcardsResult {
  logEntryCid: string;
  newLogHeadCid: string;
}

interface UpdateResponseBody {
  log_entry_cid: string;
  new_log_head_cid: string;
}

async function submitActiveSubcardsUpdate(
  options: UpdateActiveSubcardsOptions,
  code: 510 | 511 | 512,
  newActiveSubcards: string[]
): Promise<UpdateSubcardsResult> {
  const updateIntent = {
    target_card: options.holderCardPointer,
    updater_card: options.holder.cardPointer,
    code,
    field_updates: [
      {
        field: 'active_subcards',
        value: newActiveSubcards,
      },
    ],
    notify_holder: options.notifyHolder ?? true,
    ...(options.note ? { note: options.note } : {}),
    timestamp: options.effectiveDate ?? new Date().toISOString(),
  };

  const intentSignature = await options.holder.sign(canonicalize(updateIntent));

  const response = await options.transport.request(
    { kind: 'press', baseUrl: options.pressBaseUrl },
    {
      method: 'POST',
      path: '/update',
      headers: { 'content-type': 'application/json' },
      body: new TextEncoder().encode(
        JSON.stringify({ update_intent: updateIntent, intent_signature: bytesToBase64Url(intentSignature) })
      ),
    }
  );

  if (response.status < 200 || response.status >= 300) {
    throw new Error(`Active subcards update (code ${code}): POST /update returned status ${response.status}`);
  }

  const body = JSON.parse(new TextDecoder().decode(response.body)) as UpdateResponseBody;
  return { logEntryCid: body.log_entry_cid, newLogHeadCid: body.new_log_head_cid };
}

/**
 * Add a sub-card public key to the holder's `active_subcards` directory.
 *
 * Submits a code-510 update intent to the holder's own master card. The holder
 * must provide the full new `active_subcards` array (including the newly added pubkey).
 *
 * @param options Configuration: holder identity, press endpoint, new array.
 * @returns { logEntryCid, newLogHeadCid } from the press response.
 */
export async function addActiveSubCard(options: AddActiveSubCardOptions): Promise<UpdateSubcardsResult> {
  return submitActiveSubcardsUpdate(options, 510, options.newActiveSubcards);
}

/**
 * Remove a sub-card public key from the holder's `active_subcards` directory.
 *
 * Submits a code-511 update intent to the holder's own master card. The holder
 * must provide the full new `active_subcards` array (with the removed pubkey deleted).
 *
 * @param options Configuration: holder identity, press endpoint, new array.
 * @returns { logEntryCid, newLogHeadCid } from the press response.
 */
export async function removeActiveSubCard(options: RemoveActiveSubCardOptions): Promise<UpdateSubcardsResult> {
  return submitActiveSubcardsUpdate(options, 511, options.newActiveSubcards);
}

/**
 * Atomically rotate a sub-card public key in the holder's `active_subcards` directory.
 *
 * Submits a code-512 update intent to the holder's own master card. Code-512 is
 * a single atomic entry (one old pubkey swapped for one new pubkey), not a 511+510 pair.
 *
 * The holder must provide the full new `active_subcards` array with the rotation applied
 * (exactly one pubkey removed and one new pubkey in its place).
 *
 * @param options Configuration: holder identity, press endpoint, new array.
 * @returns { logEntryCid, newLogHeadCid } from the press response.
 */
export async function rotateActiveSubCard(options: RotateActiveSubCardOptions): Promise<UpdateSubcardsResult> {
  return submitActiveSubcardsUpdate(options, 512, options.newActiveSubcards);
}
