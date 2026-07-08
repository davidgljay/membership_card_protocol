import { canonicalize, mlDsa44Sign } from '@membership-card-protocol/app-sdk';
import { bytesToBase64Url } from '@membership-card-protocol/app-sdk';
import type { ObliviousProtocolTransport } from '@membership-card-protocol/app-sdk';

/**
 * Active sub-card directory maintenance (codes 510/511; `update_codes.md §5xx`,
 * `card_updates.md §Sub-Card Directory Updates`).
 *
 * Submitted via the general card-update-intent flow (`POST /update`), these
 * are 5xx field-update entries (not 8xx revocations) that add (510) or
 * remove (511) one entry to/from the holder's `active_subcards` directory on
 * the master card. Code 512 (atomic rotation) is out of scope for this step.
 *
 * **Who signs:** Always the holder's primary card key — the `updater_card` in
 * the payload is the master card itself (`target_card === updater_card`), and
 * `intent_signature` is produced with the holder's master key. There is no
 * cross-card scenario for these codes, and no signer callback path
 * (`UpdateIntentSigner` from `revocation.ts`) — {@link
 * postSubCardAddedToDirectory} and {@link postSubCardRemovedFromDirectory}
 * take `masterSecretKey: Uint8Array` directly and sign internally via
 * `mlDsa44Sign`, so there is no SDK-exposed code path that could construct an
 * update signed by anything else. This mirrors {@link deregisterSubCard}'s
 * structural enforcement from `subCardDeregistration.ts`.
 *
 * **Payload shape:** Both functions construct an update-intent with
 * `field_updates: [{ field: 'active_subcards', value: <full new array> }]`
 * — the complete new directory (append for 510, filter-exact-one for 511),
 * not a delta. `active_subcards` is an array of base64url-encoded public keys.
 *
 * **Filter semantics (code 511):** If the pubkey to remove is not present in
 * the array, the array is returned unchanged. This is a no-op rather than an
 * error — it allows callers to idempotently submit removal intents without
 * first checking the current state.
 */

export type SubCardDirectoryUpdateCode = 510 | 511;

/**
 * Shared options for both add/remove directory updates.
 */
interface ActiveSubcardsUpdateBaseOptions {
  transport: ObliviousProtocolTransport;
  /** Any press listed in the card's `approved_presses` — a holder can submit through any of them. */
  pressBaseUrl: string;
  /** `target_card` — mutable pointer of the holder's own master card. Since these codes are hardcoded holder-only, `updater_card` is always identical. */
  masterCardPointer: string;
  /** The holder's primary (master) card private key — the only signer these operations accept. */
  masterSecretKey: Uint8Array;
  /** Defaults to now. */
  timestamp?: string;
  /** Defaults to `false`. */
  notifyHolder?: boolean;
}

/**
 * Options for adding a sub-card to the active directory (code 510).
 */
export interface PostSubCardAddedOptions extends ActiveSubcardsUpdateBaseOptions {
  /** The current `active_subcards` array (array of base64url-encoded pubkeys), if it exists. If missing/null, treated as an empty array. */
  currentActiveSubcards: string[] | null;
  /** The base64url-encoded public key to add. */
  newSubCardPublicKey: string;
}

/**
 * Options for removing a sub-card from the active directory (code 511).
 */
export interface PostSubCardRemovedOptions extends ActiveSubcardsUpdateBaseOptions {
  /** The current `active_subcards` array (array of base64url-encoded pubkeys). */
  currentActiveSubcards: string[];
  /** The base64url-encoded public key to remove. */
  removedSubCardPublicKey: string;
  /** Optional note explaining the removal (e.g., "device lost", "app uninstalled"). */
  note?: string;
}

export interface ActiveSubcardsUpdateResult {
  logEntryCid: string;
  newLogHeadCid: string;
}

interface UpdateResponseBody {
  log_entry_cid: string;
  new_log_head_cid: string;
}

interface FieldUpdate {
  field: string;
  value: string[];
}

interface UpdateIntentPayload {
  target_card: string;
  updater_card: string;
  code: SubCardDirectoryUpdateCode;
  field_updates: FieldUpdate[];
  timestamp: string;
  notify_holder: boolean;
  note?: string;
}

/**
 * Post a code-510 update to add a sub-card to the holder's `active_subcards`
 * directory.
 *
 * @param options - Configuration including transport, press URL, current
 * active subcards array, and the new pubkey to append.
 * @returns The IPFS CID of the new log entry and the new log head.
 * @throws If the transport request fails or returns a non-2xx status.
 */
export async function postSubCardAddedToDirectory(
  options: PostSubCardAddedOptions
): Promise<ActiveSubcardsUpdateResult> {
  const newArray = [...(options.currentActiveSubcards ?? [])];
  if (!newArray.includes(options.newSubCardPublicKey)) {
    newArray.push(options.newSubCardPublicKey);
  }

  const updateIntent: UpdateIntentPayload = {
    target_card: options.masterCardPointer,
    updater_card: options.masterCardPointer,
    code: 510,
    field_updates: [{ field: 'active_subcards', value: newArray }],
    timestamp: options.timestamp ?? new Date().toISOString(),
    notify_holder: options.notifyHolder ?? false,
  };

  const intentSignature = mlDsa44Sign(options.masterSecretKey, canonicalize(updateIntent));

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
    throw new Error(`postSubCardAddedToDirectory: POST /update returned status ${response.status}`);
  }

  const body = JSON.parse(new TextDecoder().decode(response.body)) as UpdateResponseBody;
  return { logEntryCid: body.log_entry_cid, newLogHeadCid: body.new_log_head_cid };
}

/**
 * Post a code-511 update to remove a sub-card from the holder's
 * `active_subcards` directory.
 *
 * @param options - Configuration including transport, press URL, current
 * active subcards array, and the pubkey to remove.
 * @returns The IPFS CID of the new log entry and the new log head.
 * @throws If the transport request fails or returns a non-2xx status.
 *
 * **Note:** If the pubkey to remove is not present in the current array, the
 * array is returned unchanged. The update is posted as a no-op, allowing
 * callers to idempotently submit removal intents.
 */
export async function postSubCardRemovedFromDirectory(
  options: PostSubCardRemovedOptions
): Promise<ActiveSubcardsUpdateResult> {
  const newArray = options.currentActiveSubcards.filter((pk) => pk !== options.removedSubCardPublicKey);

  const updateIntent: UpdateIntentPayload = {
    target_card: options.masterCardPointer,
    updater_card: options.masterCardPointer,
    code: 511,
    field_updates: [{ field: 'active_subcards', value: newArray }],
    timestamp: options.timestamp ?? new Date().toISOString(),
    notify_holder: options.notifyHolder ?? false,
    ...(options.note ? { note: options.note } : {}),
  };

  const intentSignature = mlDsa44Sign(options.masterSecretKey, canonicalize(updateIntent));

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
    throw new Error(`postSubCardRemovedFromDirectory: POST /update returned status ${response.status}`);
  }

  const body = JSON.parse(new TextDecoder().decode(response.body)) as UpdateResponseBody;
  return { logEntryCid: body.log_entry_cid, newLogHeadCid: body.new_log_head_cid };
}
