/**
 * Card update and revocation handler (press.md §5.3).
 * POST /update
 */

import type { PressContext } from '../context.js';
import { canonicalize } from '../serialization.js';
import { fromBase64url, keccak256, deriveContentKey, aes256gcmDecrypt } from '../functions/crypto.js';
import { mlDsa44Verify } from '@membership-card-protocol/verifier';
import type { CardDocument } from '@membership-card-protocol/verifier';
import { appendLogEntry, readCurrentHead } from '../functions/log.js';
import { checkRateLimits, recordWrite } from '../functions/predicates.js';
import { fetchPolicyCard } from '../functions/issuance.js';
import { assertDomainBindingIntent, assertPreferredServices } from '../functions/login.js';
import {
  diffActiveSubcards,
  notifySubcardSiblings,
  buildSubcardSiblingAddedContent,
  buildSubcardSiblingRemovedContent,
  buildSubcardSiblingRotatedContent,
} from '../functions/notifications.js';
import type { UpdateRequest, UpdateResponse, UpdateIntentPayload } from '../types.js';
import type { Hex } from 'viem';

/**
 * Codes 510 (sub-card addition), 511 (removal), and 512 (rotation) update the
 * `active_subcards` field on the updater's own master card. Per
 * `protocol-objects.md §1.1` and `process_specs/card_updates.md`
 * ("Sub-Card Directory Updates"), authorization for these three codes is
 * hardcoded to the target card's own holder key and is NOT subject to the
 * governing policy's `update_policy` — a policy can never grant an issuer or
 * any other party this authority.
 */
const ACTIVE_SUBCARDS_DIRECTORY_CODES = new Set([510, 511, 512]);

/**
 * Codes 100 (rotation), 101 (?), and 102 (issuer-initiated, 72h pending
 * window) are the only mechanisms that may set `successor` — see
 * `protocol-objects.md` §1.1 and `key_rotation.md §8`. Once effective,
 * `successor` is itself immutable (may be set at most once).
 */
const SUCCESSOR_CODES = new Set([100, 101, 102]);

/** Code 520 sets a login service card's domain_binding, once (press.md §5.3 step 4a). */
const DOMAIN_BINDING_CODE = 520;

/**
 * Protocol-required immutable fields (protocol-objects.md §1/§1.1,
 * process_specs/card_updates.md step 7) — an ordinary field_updates entry
 * may never target these. `active_subcards` and `successor` are each
 * mutable, but only via their own dedicated update-code mechanism, not a
 * generic field_updates entry outside it (see isImmutableFieldUpdateAllowed
 * below). `supersedes`/`supersession_note` are genesis-only per
 * protocol-objects.md §1.1 (set by the issuer at card creation) — no
 * update code sets them at all, so they carry no exemption here.
 */
const IMMUTABLE_FIELDS = new Set([
  'policy_id',
  'issuer_card',
  'press_card',
  'recipient_pubkey',
  'issued_at',
  'issuer_signature',
  'holder_signature',
  'press_signature',
  'ancestry_pubkeys',
  'past_keys',
  'protocol_version',
  'active_subcards',
  'successor',
  'supersedes',
  'supersession_note',
  'domain_binding',
]);

function isImmutableFieldUpdateAllowed(field: string, code: number): boolean {
  if (field === 'active_subcards') return ACTIVE_SUBCARDS_DIRECTORY_CODES.has(code);
  if (field === 'successor') return SUCCESSOR_CODES.has(code);
  if (field === 'domain_binding') return code === DOMAIN_BINDING_CODE;
  return false;
}

export async function handleUpdate(
  ctx: PressContext,
  body: UpdateRequest
): Promise<UpdateResponse> {
  const { update_intent: rawIntent, intent_signature } = body;

  // 1. Verify intent signature using the updater's ML-DSA-44 public key.
  //    Resolve the updater's public key via verifyCard (extracts from chain result).
  //    For Phase 3: we use the key provided directly in intent_signature.
  //    The signature covers the intent exactly as the client sent it.
  const toVerify = canonicalize(rawIntent as unknown as Record<string, unknown>);
  const updaterPubkey = fromBase64url(intent_signature.public_key);
  const sigValid = mlDsa44Verify(
    updaterPubkey,
    toVerify,
    fromBase64url(intent_signature.signature)
  );
  if (!sigValid) {
    throw Object.assign(
      new Error('P-09: Invalid intent_signature on UpdateIntentPayload'),
      { pressCode: 'P-09' }
    );
  }

  // Accept the spec's field names (protocol-objects.md §4: target_card,
  // updater_card) as well as this press's historical *_address names.
  const named = rawIntent as UpdateIntentPayload & { target_card?: string; updater_card?: string };
  const update_intent: UpdateIntentPayload = {
    ...named,
    target_card_address: named.target_card_address ?? named.target_card ?? '',
    updater_card_address: named.updater_card_address ?? named.updater_card ?? '',
  };
  if (!update_intent.target_card_address || !update_intent.updater_card_address) {
    throw Object.assign(new Error('P-01: update intent needs target_card and updater_card'), { pressCode: 'P-01' });
  }

  // 2. Stale timestamp check.
  const intentAge = Date.now() - new Date(update_intent.timestamp).getTime();
  const MAX_AGE_MS = ctx.config.STALENESS_WINDOW_SECONDS * 1000;
  if (intentAge > MAX_AGE_MS) {
    throw Object.assign(
      new Error('P-22: UpdateIntent timestamp is stale'),
      { pressCode: 'P-22' }
    );
  }

  // 2b. Immutable fields (process_specs/card_updates.md step 7,
  // protocol-objects.md §1/§1.1) -- reject fast, before any registry/IPFS
  // lookups, if field_updates targets a protocol-required immutable field
  // outside its own dedicated update-code mechanism (if it has one).
  for (const update of update_intent.field_updates ?? []) {
    if (IMMUTABLE_FIELDS.has(update.field) && !isImmutableFieldUpdateAllowed(update.field, update_intent.code)) {
      throw Object.assign(
        new Error(`P-25: field_updates targets protocol-required immutable field '${update.field}'`),
        { pressCode: 'P-25' }
      );
    }
  }

  // 2c. preferred_services shape (press.md §5.3 step 5a, P-29).
  assertPreferredServices(update_intent.field_updates);

  // 3. Resolve target card's policy.
  const targetAddress = update_intent.target_card_address as Hex;
  const cardEntry = await ctx.registry.getCardEntry(targetAddress);
  if (!cardEntry.exists) {
    throw Object.assign(new Error('Target card not found'), { pressCode: 'P-01' });
  }
  const policyAddress = cardEntry.policy_address;

  // Find the policy CID from the press's configured policies (rough match by address).
  // Phase 3: resolve the policy CID from the press config or on-chain event history.
  const policyCid = ctx.config.PRESS_POLICY_CIDS[0] ?? '';
  let policy;
  try {
    policy = await fetchPolicyCard(ctx.ipfs, policyCid);
  } catch {
    policy = { field_definitions: {}, approved_presses: [ctx.config.PRESS_CARD_CID] } as import('../types.js').PolicyDocument;
  }

  // 4. Evaluate update_policy predicate (P-11) for field updates (1xx–7xx codes).
  if (ACTIVE_SUBCARDS_DIRECTORY_CODES.has(update_intent.code) || update_intent.code === DOMAIN_BINDING_CODE) {
    // Codes 510/511/512: hardcoded holder-only authorization, never policy-configurable.
    // The updater must be the target card itself (only a card's own holder key may touch
    // its own active_subcards), and the intent_signature's public key must actually bind
    // to that same address — otherwise "updater === target" is just a claim in the JSON
    // body with no cryptographic backing.
    if (update_intent.updater_card_address !== update_intent.target_card_address) {
      throw Object.assign(
        new Error(
          'P-23: Codes 510/511/512/520 (holder-only updates) must be self-updates — updater_card_address must equal target_card_address'
        ),
        { pressCode: 'P-23' }
      );
    }

    // Unprefixed — see functions/issuance.ts's verifyIssuerSignature for
    // the full explanation of why this must match wallet-sdk's convention.
    const signerAddress = Buffer.from(keccak256(updaterPubkey)).toString('hex');
    if (signerAddress.toLowerCase() !== targetAddress.toLowerCase()) {
      throw Object.assign(
        new Error('P-13: intent_signature public_key does not bind to target_card_address'),
        { pressCode: 'P-13' }
      );
    }

    // 4a. Code 520: validate the domain binding (P-28).
    if (update_intent.code === DOMAIN_BINDING_CODE) {
      await assertDomainBindingIntent(ctx, update_intent.field_updates, update_intent.target_card_address, intent_signature.public_key);
    }
  } else if (update_intent.code < 800) {
    // Verify the updater's chain reaches a trusted root (satisfies the default update predicate).
    // Full per-field update_policy predicate evaluation requires decrypting the target card,
    // which is a Phase 4+ enhancement. For now: chain validity is the gate.
    const updaterResult = await ctx.verifier.verifyCard(update_intent.updater_card_address);
    if (updaterResult.chain_reaches_trusted_root !== true) {
      throw Object.assign(
        new Error('P-11: Updater card chain does not satisfy the update_policy predicate'),
        { pressCode: 'P-11' }
      );
    }

    // Rate limit check for 1xx codes.
    if (update_intent.code < 200) {
      await checkRateLimits(ctx.kv, 'update_card_head', update_intent.updater_card_address, 'holder', policyAddress);
    }
  }

  // 4b. For 510/511/512, snapshot the pre-update active_subcards array so we can
  // diff against the post-update value after the log entry is appended (needed
  // to identify which single pubkey changed, per messaging_protocol.md §9-11).
  // Per ADR-006, content is decryptable by anyone holding the card's own public
  // key — the press already confirmed intent_signature.public_key is that key
  // in step 4, so no additional authorization is implied by reading it here.
  // The target card's public key: the press needs it to read the current head
  // and to encrypt the new log entry under the card's content key (ADR-006).
  const isSelfUpdate = update_intent.updater_card_address.toLowerCase().replace(/^0x/, '') === targetAddress.toLowerCase().replace(/^0x/, '');
  let targetPubkey: Uint8Array;
  if (body.target_card_pubkey) {
    targetPubkey = fromBase64url(body.target_card_pubkey);
  } else if (isSelfUpdate) {
    targetPubkey = updaterPubkey;
  } else {
    throw Object.assign(new Error('P-01: target_card_pubkey is required when the updater is not the target card'), { pressCode: 'P-01' });
  }
  if (Buffer.from(keccak256(targetPubkey)).toString('hex') !== targetAddress.toLowerCase().replace(/^0x/, '')) {
    throw Object.assign(new Error('P-13: target_card_pubkey does not bind to target_card_address'), { pressCode: 'P-13' });
  }

  let preUpdateActiveSubcards: string[] = [];
  if (ACTIVE_SUBCARDS_DIRECTORY_CODES.has(update_intent.code)) {
    try {
      const head = await readCurrentHead(ctx.ipfs, new TextDecoder().decode(cardEntry.log_head_cid), deriveContentKey(targetPubkey));
      preUpdateActiveSubcards = (head.state['active_subcards'] as string[] | undefined) ?? [];
    } catch (err) {
      // Never block the update itself on a notification pre-check failure —
      // notification is a best-effort side channel, not part of the protocol
      // invariant. We simply won't be able to notify siblings for this update.
      console.warn(`[press] Could not read pre-update active_subcards for ${targetAddress}: ${String(err)}`);
    }
  }

  // 5. Append log entry.
  const result = await appendLogEntry(
    ctx.config,
    ctx.kv,
    ctx.registry,
    ctx.ipfs,
    targetAddress,
    update_intent,
    intent_signature,
    targetPubkey
  );

  // 6. Record write for rate limiting (field updates only).
  if (update_intent.code < 800) {
    await recordWrite(ctx.kv, 'update_card_head', update_intent.updater_card_address, 'holder', policyAddress, policy);
  }

  // 7. Sibling sub-card notification (510/511/512 only) — best-effort, never
  // throws, never affects the response returned to the caller.
  if (ACTIVE_SUBCARDS_DIRECTORY_CODES.has(update_intent.code)) {
    try {
      const postUpdateActiveSubcards =
        (update_intent.field_updates?.find((u) => u.field === 'active_subcards')?.value as string[] | undefined) ?? [];
      const diff = diffActiveSubcards(
        update_intent.code as 510 | 511 | 512,
        preUpdateActiveSubcards,
        postUpdateActiveSubcards
      );
      if (diff) {
        const timestamp = new Date().toISOString();
        if (diff.code === 510) {
          const content = buildSubcardSiblingAddedContent(targetAddress, diff.newPubkey, result.log_entry_cid, timestamp);
          await notifySubcardSiblings('subcard_sibling_added', diff.recipients, content);
        } else if (diff.code === 511) {
          const content = buildSubcardSiblingRemovedContent(targetAddress, diff.removedPubkey, result.log_entry_cid, timestamp);
          await notifySubcardSiblings('subcard_sibling_removed', diff.recipients, content);
        } else {
          const content = buildSubcardSiblingRotatedContent(
            targetAddress,
            diff.oldPubkey,
            diff.newPubkey,
            result.log_entry_cid,
            timestamp
          );
          await notifySubcardSiblings('subcard_sibling_rotated', diff.recipients, content);
        }
      } else {
        console.warn(
          `[press] Skipping sibling notification for ${targetAddress}: active_subcards diff did not match code ${update_intent.code}'s expected shape`
        );
      }
    } catch (err) {
      console.warn(`[press] Sibling sub-card notification failed for ${targetAddress}: ${String(err)}`);
    }
  }

  return result;
}
