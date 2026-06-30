/**
 * Per-device delivery (implementation-plan.md §Step 4.4 — revised
 * mid-Phase-4). The message arriving here is already addressed to one
 * specific sub-card and already encrypted to that sub-card's key by the
 * sender (message_routing.md v0.4 §Sender-Side Fan-out) — there is no
 * re-encryption transform. Claim the next UUID from that sub-card's pool
 * and hand the payload to the relay unchanged, advancing to the next UUID
 * on 404/410/5xx.
 */

import type { Pool } from 'pg';
import { loadConfig } from '../../src/config.js';
import { deliverToRelay } from '../../src/relay-client.js';
import { claimNextUuid } from '../db/uuid-pools.js';
import { setDeliveryUuid, type MessageQueueRow } from '../db/messages.js';

const MAX_UUID_ATTEMPTS = 5; // bounded retry across 404/410/5xx "try next UUID" hops

export async function deliverMessage(pool: Pool, message: MessageQueueRow): Promise<void> {
  if (!message.subcard_hash) {
    console.warn(`[wallet-service] message has no subcard_hash, cannot deliver message_id=${message.id}`);
    return;
  }
  const config = loadConfig();

  for (let attempt = 0; attempt < MAX_UUID_ATTEMPTS; attempt++) {
    const uuid = await claimNextUuid(pool, message.card_hash, message.subcard_hash);
    if (!uuid) {
      console.warn(`[wallet-service] no UUIDs available for subcard, delivery deferred message_id=${message.id}`);
      return;
    }

    const result = await deliverToRelay(config.RELAY_BASE_URL, uuid, message.payload);
    if (result === 'delivered') {
      await setDeliveryUuid(pool, message.id, uuid);
      return;
    }
    // 'uuid_invalid' (404/410) and 'server_error' both advance to the next
    // UUID rather than retrying the same one — see implementation-plan.md
    // §Step 4.4 for why a sustained relay outage is better handled by
    // Phase 5's re-registration/retransmission path than by burning
    // through this sub-card's UUID pool on retries.
    console.warn(`[wallet-service] relay delivery ${result}, advancing to next UUID message_id=${message.id}`);
  }
}
