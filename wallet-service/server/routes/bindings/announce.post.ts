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

export default defineEventHandler(async (event) => {
  const envelope = await readBody<AnnouncementEnvelope>(event);
  if (!envelope?.payload || !Array.isArray(envelope.signatures)) {
    throw createError({ statusCode: 400, statusMessage: 'payload and signatures are required.' });
  }

  const verification = verifyAnnouncementEnvelope(envelope);
  if (!verification.ok) {
    throw createError({ statusCode: 401, statusMessage: `Invalid announcement: ${verification.reason}.` });
  }

  const pool = getPool();

  const isNew = await recordNonceIfNew(pool, envelope.payload.nonce);
  if (!isNew) {
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
    console.info(
      `[wallet-service] binding announcement applied card_hash=${envelope.payload.card_hash} type=${envelope.payload.type}`
    );
  }

  return { applied: accepted };
});
