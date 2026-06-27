/**
 * Predicate evaluation and rate limiting.
 *
 * evaluatePredicates — validates requester and recipient card chains using the
 *   CardVerifier and checks any requester_predicate/recipient_predicate in the
 *   policy document.
 *
 * checkRateLimits / recordWrite — enforce 7-day rolling window limits per the
 *   table in press.md §6. Counters live in the external KV store.
 *
 * sendSuspiciousActivityAlert — POST to the granting agency when any counter
 *   reaches 80% of the configured limit.
 */

import type { CardVerifier, CardVerificationResult } from '@membership-card-protocol/verifier';
import type { KvStore } from '../kv.js';
import { kvKeys } from '../kv.js';
import type { PolicyDocument, Predicate } from '../types.js';

// ---------------------------------------------------------------------------
// Weekly rate limit table (press.md §6)
// ---------------------------------------------------------------------------

const RATE_LIMITS: Record<string, number> = {
  register_card: 1000,
  update_card_head: 20,
  register_sub_card: 10,
  register_sub_card_app: 500,
  deregister_sub_card: 10,
  policy_total: 1000,
};

const ALERT_THRESHOLD = 0.8;
const WINDOW_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// ---------------------------------------------------------------------------
// Predicate evaluation
// ---------------------------------------------------------------------------

export interface PredicateResult {
  passed: true;
  requesterResult: CardVerificationResult;
  recipientResult: CardVerificationResult;
}

export async function evaluatePredicates(
  verifier: CardVerifier,
  policy: PolicyDocument,
  requesterCardAddress: string,
  recipientCardAddress: string,
  stalenessWindowSeconds: number
): Promise<PredicateResult> {
  // Verify requester chain.
  const requesterResult = await verifier.verifyCard(requesterCardAddress);
  if (requesterResult.chain_reaches_trusted_root !== true) {
    throw Object.assign(
      new Error('P-02: Requester card chain does not reach a trusted root'),
      { pressCode: 'P-02' }
    );
  }
  if (requesterResult.is_currently_valid === false) {
    throw Object.assign(
      new Error('P-04: Requester card is revoked'),
      { pressCode: 'P-04' }
    );
  }
  if (requesterResult.revocation.data_freshness_seconds > stalenessWindowSeconds) {
    throw Object.assign(
      new Error('P-17: Revocation data is stale for requester'),
      { pressCode: 'P-17' }
    );
  }

  // Verify recipient chain.
  const recipientResult = await verifier.verifyCard(recipientCardAddress);
  if (recipientResult.chain_reaches_trusted_root !== true) {
    throw Object.assign(
      new Error('P-03: Recipient card chain does not reach a trusted root'),
      { pressCode: 'P-03' }
    );
  }
  if (recipientResult.is_currently_valid === false) {
    throw Object.assign(
      new Error('P-04: Recipient card is revoked'),
      { pressCode: 'P-04' }
    );
  }
  if (recipientResult.revocation.data_freshness_seconds > stalenessWindowSeconds) {
    throw Object.assign(
      new Error('P-17: Revocation data is stale for recipient'),
      { pressCode: 'P-17' }
    );
  }

  // Evaluate requester_predicate.
  if (policy.requester_predicate) {
    const ok = evaluatePredicate(policy.requester_predicate, requesterResult);
    if (!ok) {
      throw Object.assign(
        new Error('P-02: Requester predicate not satisfied'),
        { pressCode: 'P-02' }
      );
    }
  }

  // Evaluate recipient_predicate.
  if (policy.recipient_predicate) {
    const ok = evaluatePredicate(policy.recipient_predicate, recipientResult);
    if (!ok) {
      throw Object.assign(
        new Error('P-03: Recipient predicate not satisfied'),
        { pressCode: 'P-03' }
      );
    }
  }

  return { passed: true, requesterResult, recipientResult };
}

/**
 * Evaluate a single predicate against a CardVerificationResult.
 *
 * Supported predicate types:
 * - "chain_valid"   — passes if chain_reaches_trusted_root and is_currently_valid
 * - "field_match"   — passes if a specific field on the card matches (requires IPFS fetch;
 *                     not implemented in Phase 3 — treated as passing for unknown predicates)
 * - unknown types   — treated as passing (permissive default, operator configures constraints)
 */
function evaluatePredicate(
  predicate: Predicate,
  result: CardVerificationResult
): boolean {
  switch (predicate.type) {
    case 'chain_valid':
      return (
        result.chain_reaches_trusted_root === true &&
        result.is_currently_valid !== false
      );
    case 'field_match':
      // Phase 3: field_match requires fetching the decrypted card document,
      // which the press cannot do (only the holder can decrypt). Log and pass.
      console.warn('[press] field_match predicate encountered — deferred to Phase 4');
      return true;
    default:
      // Unknown predicate type: pass permissively, log for operator review.
      console.warn(`[press] Unknown predicate type "${predicate.type}" — treating as passing`);
      return true;
  }
}

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

function windowStart(): number {
  return Math.floor(Date.now() / WINDOW_MS) * WINDOW_MS;
}

export async function checkRateLimits(
  kv: KvStore,
  operation: string,
  entityAddress: string,
  entityType: string,
  policyAddress: string
): Promise<void> {
  const ws = windowStart();

  // Per-entity limit.
  const entityKey = kvKeys.rateEntity(entityAddress, entityType, operation, policyAddress, ws);
  const entityCount = (await kv.getItem<number>(entityKey)) ?? 0;
  const entityLimit = RATE_LIMITS[operation] ?? 100;
  if (entityCount >= entityLimit) {
    throw Object.assign(
      new Error(`P-18: Rate limit reached for ${operation} (${entityCount}/${entityLimit})`),
      { pressCode: 'P-18' }
    );
  }

  // Per-policy press-funded total (applies to all press-funded operations).
  const policyKey = kvKeys.policyWrites(policyAddress, ws);
  const policyCount = (await kv.getItem<number>(policyKey)) ?? 0;
  const policyLimit = RATE_LIMITS['policy_total'] ?? 1000;
  if (policyCount >= policyLimit) {
    throw Object.assign(
      new Error(`P-19: Per-policy write limit reached (${policyCount}/${policyLimit})`),
      { pressCode: 'P-19' }
    );
  }
}

export async function recordWrite(
  kv: KvStore,
  operation: string,
  entityAddress: string,
  entityType: string,
  policyAddress: string,
  policyCard: PolicyDocument
): Promise<void> {
  const ws = windowStart();

  const entityKey = kvKeys.rateEntity(entityAddress, entityType, operation, policyAddress, ws);
  const entityCount = await kv.increment(entityKey);
  const policyKey = kvKeys.policyWrites(policyAddress, ws);
  await kv.increment(policyKey);

  // Alert at 80% threshold.
  const entityLimit = RATE_LIMITS[operation] ?? 100;
  if (entityCount >= Math.floor(entityLimit * ALERT_THRESHOLD)) {
    await sendSuspiciousActivityAlert(
      entityAddress,
      entityType,
      operation,
      entityCount,
      entityLimit,
      policyAddress,
      policyCard
    );
  }
}

async function sendSuspiciousActivityAlert(
  entityAddress: string,
  entityType: string,
  operation: string,
  currentCount: number,
  limit: number,
  policyAddress: string,
  policyCard: PolicyDocument
): Promise<void> {
  const endpoint = (policyCard as Record<string, unknown>)['admin_wallet_service_url'] as
    | string
    | undefined;
  if (!endpoint) {
    console.warn(
      `[press] Suspicious activity at ${currentCount}/${limit} for ${operation} by ${entityAddress} — no admin endpoint configured`
    );
    return;
  }

  const payload = {
    entity_card: entityAddress,
    entity_type: entityType,
    operation,
    current_count: currentCount,
    limit,
    window_start: new Date(windowStart()).toISOString(),
    timestamp: new Date().toISOString(),
  };

  try {
    await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    console.error(`[press] Failed to send suspicious activity alert: ${String(err)}`);
  }
}
