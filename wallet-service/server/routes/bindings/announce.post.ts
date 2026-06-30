/**
 * POST /bindings/announce — implementation-plan.md §Step 4.1.
 * Receives a signed CardBindingAnnouncement from a peer wallet service.
 * Verifies all required signatures, checks the nonce hasn't been replayed,
 * and applies the conflict resolution rules from
 * message_routing.md §Binding Conflict Resolution before updating the
 * local routing table.
 */

import { getPool } from '../../db/client.js';
import { findRoutingEntry, upsertRoutingEntry, recordNonceIfNew } from '../../db/routing.js';
import {
  verifyAnnouncementEnvelope,
  shouldAcceptAnnouncement,
  type AnnouncementEnvelope,
} from '../../../src/federation/binding.js';
import { enforceRateLimit } from '../../utils/enforce-rate-limit.js';
import { kvKeys } from '../../../src/kv.js';
import { auditLog } from '../../utils/audit-log.js';

const ANNOUNCE_RATE_LIMIT = 100;
const ANNOUNCE_RATE_WINDOW_SECONDS = 60;

export default defineEventHandler(async (event) => {
  const envelope = await readBody<AnnouncementEnvelope>(event);
  if (!envelope?.payload || !Array.isArray(envelope.signatures)) {
    throw createError({ statusCode: 400, statusMessage: 'payload and signatures are required.' });
  }

  const verification = verifyAnnouncementEnvelope(envelope);
  if (!verification.ok) {
    auditLog('warn', 'binding_announcement_rejected', {
      card_hash: envelope.payload.card_hash,
      peer_wallet_id: envelope.payload.wallet_service_id,
      outcome: verification.reason,
    });
    throw createError({ statusCode: 401, statusMessage: `Invalid announcement: ${verification.reason}.` });
  }

  // Rate-limited only after signature verification — the limit protects
  // against a legitimate-but-spamming peer, keyed by their now-verified
  // identity. An unverified claimed id can't be used to rate-limit a
  // victim peer this way.
  await enforceRateLimit(
    event,
    kvKeys.bindingAnnounceRate(envelope.payload.wallet_service_id),
    ANNOUNCE_RATE_LIMIT,
    ANNOUNCE_RATE_WINDOW_SECONDS
  );

  const pool = getPool();

  const isNew = await recordNonceIfNew(pool, envelope.payload.nonce);
  if (!isNew) {
    auditLog('warn', 'binding_announcement_rejected', {
      card_hash: envelope.payload.card_hash,
      peer_wallet_id: envelope.payload.wallet_service_id,
      outcome: 'nonce_replay',
    });
    throw createError({ statusCode: 409, statusMessage: 'Nonce already seen — possible replay.' });
  }

  const existing = await findRoutingEntry(pool, envelope.payload.card_hash);
  const accepted = shouldAcceptAnnouncement(existing, envelope.payload);

  if (accepted) {
    await upsertRoutingEntry(pool, {
      card_hash: envelope.payload.card_hash,
      wallet_service_id: envelope.payload.wallet_service_id,
      endpoint: envelope.payload.endpoint,
      type: envelope.payload.type,
      announced_at: new Date(envelope.payload.timestamp),
      nonce: envelope.payload.nonce,
      signatures: envelope.signatures,
    });
  }

  auditLog('info', 'binding_announcement_processed', {
    card_hash: envelope.payload.card_hash,
    peer_wallet_id: envelope.payload.wallet_service_id,
    outcome: accepted ? 'accepted' : 'rejected_conflict',
  });

  return { applied: accepted };
});
