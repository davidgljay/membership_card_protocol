/**
 * Card update and revocation handler (press.md §5.3).
 * POST /update
 */

import type { PressContext } from '../context.js';
import { canonicalize } from '../serialization.js';
import { fromBase64url } from '../functions/crypto.js';
import { mlDsa44Verify } from '@membership-card-protocol/verifier';
import { appendLogEntry } from '../functions/log.js';
import { checkRateLimits, recordWrite } from '../functions/predicates.js';
import { fetchPolicyCard } from '../functions/issuance.js';
import type { UpdateRequest, UpdateResponse } from '../types.js';
import type { Hex } from 'viem';

export async function handleUpdate(
  ctx: PressContext,
  body: UpdateRequest
): Promise<UpdateResponse> {
  const { update_intent, intent_signature } = body;

  // 1. Verify intent signature using the updater's ML-DSA-44 public key.
  //    Resolve the updater's public key via verifyCard (extracts from chain result).
  //    For Phase 3: we use the key provided directly in intent_signature.
  const toVerify = canonicalize(update_intent as unknown as Record<string, unknown>);
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

  // 2. Stale timestamp check.
  const intentAge = Date.now() - new Date(update_intent.timestamp).getTime();
  const MAX_AGE_MS = ctx.config.STALENESS_WINDOW_SECONDS * 1000;
  if (intentAge > MAX_AGE_MS) {
    throw Object.assign(
      new Error('P-22: UpdateIntent timestamp is stale'),
      { pressCode: 'P-22' }
    );
  }

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
  if (update_intent.code < 800) {
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

  // 5. Append log entry.
  const result = await appendLogEntry(
    ctx.config,
    ctx.kv,
    ctx.registry,
    ctx.ipfs,
    targetAddress,
    update_intent,
    intent_signature
  );

  // 6. Record write for rate limiting (field updates only).
  if (update_intent.code < 800) {
    await recordWrite(ctx.kv, 'update_card_head', update_intent.updater_card_address, 'holder', policyAddress, policy);
  }

  return result;
}
