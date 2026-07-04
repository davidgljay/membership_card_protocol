/**
 * Request-orchestration logic for POST /messages (implementation-plan.md
 * §Step 4.2).
 *
 * Factored out of server/routes/messages/index.post.ts (client-sdk
 * implementation plan Step 1.4c) — see accounts-challenge.ts's doc for the
 * convention this follows. Two genuine non-error success statuses (202
 * accepted locally, 410 card_migrated to a peer) plus the usual
 * validation/lookup failures, all folded into one discriminated outcome.
 */

import type { Pool } from 'pg';
import { loadConfig, type WalletServiceConfig } from '../config.js';
import { findRoutingEntry } from '../../server/db/routing.js';
import { enqueueMessage } from '../../server/db/messages.js';
import { deliverMessage } from '../../server/utils/message-delivery.js';

export interface RawRoutingEnvelopeBody {
  to?: string;
  subcard_hash?: string;
  payload?: string;
}

export type MessagesCreateOutcome =
  | { ok: true; status: 202; body: null }
  | {
      ok: true;
      status: 410;
      body: { error: 'card_migrated'; wallet_service_id: string; endpoint: string };
    }
  | { ok: false; statusCode: 400 | 404; statusMessage: string };

export async function handleMessagesCreate(params: {
  pool: Pool;
  config?: WalletServiceConfig;
  rawBody: RawRoutingEnvelopeBody | null | undefined;
}): Promise<MessagesCreateOutcome> {
  const { pool, rawBody } = params;
  const config = params.config ?? loadConfig();

  const { to, subcard_hash: subcardHash, payload } = rawBody ?? {};
  if (!to || !subcardHash || !payload) {
    return { ok: false, statusCode: 400, statusMessage: 'to, subcard_hash, and payload are required.' };
  }

  const routing = await findRoutingEntry(pool, to);
  if (!routing) {
    return { ok: false, statusCode: 404, statusMessage: 'Unknown card_hash.' };
  }

  if (routing.wallet_service_id !== config.WALLET_SERVICE_ID) {
    return {
      ok: true,
      status: 410,
      body: {
        error: 'card_migrated',
        wallet_service_id: routing.wallet_service_id,
        endpoint: routing.endpoint,
      },
    };
  }

  const message = await enqueueMessage(pool, to, subcardHash, payload);

  // No sender information is stored or logged — only the recipient card
  // hash, target subcard_hash, and an opaque message id (message_routing.md
  // §What Wallet Services Observe).
  console.info(`[wallet-service] message received card_hash=${to} message_id=${message.id}`);

  await deliverMessage(pool, message);

  return { ok: true, status: 202, body: null };
}
