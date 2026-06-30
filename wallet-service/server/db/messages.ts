/**
 * message_queue repository (implementation-plan.md §Step 4.2, §Step 4.4,
 * §Step 4.5 — revised mid-Phase-4, see implementation-plan.md §Phase 4
 * header). Each row is already scoped to one specific sub-card — the
 * sender encrypted independently per sub-card before the routing envelope
 * ever reached this wallet service, so there is no fan-out bookkeeping
 * needed here. `delivery_uuid` tracks the most recent relay UUID this
 * message was handed to, so `DELETE /messages/{uuid}` (Step 4.5) can find
 * the right row without a separate join table.
 *
 * Retained until the relay's explicit DELETE clearance call — never
 * cleared based solely on a successful relay delivery response
 * (message_routing.md §Wallet Message Retention).
 */

import type { Pool } from 'pg';

export interface MessageQueueRow {
  id: string;
  card_hash: string;
  subcard_hash: string | null;
  payload: string;
  received_at: Date;
  cleared: boolean;
  cleared_at: Date | null;
  delivery_uuid: string | null;
}

export async function enqueueMessage(
  pool: Pool,
  cardHash: string,
  subcardHash: string,
  payload: string
): Promise<MessageQueueRow> {
  const { rows } = await pool.query<MessageQueueRow>(
    `INSERT INTO message_queue (card_hash, subcard_hash, payload) VALUES ($1, $2, $3) RETURNING *`,
    [cardHash, subcardHash, payload]
  );
  const row = rows[0];
  if (!row) {
    throw new Error('enqueueMessage: insert returned no row.');
  }
  return row;
}

export async function findUnclearedMessagesForSubcard(
  pool: Pool,
  cardHash: string,
  subcardHash: string
): Promise<MessageQueueRow[]> {
  const { rows } = await pool.query<MessageQueueRow>(
    `SELECT * FROM message_queue WHERE card_hash = $1 AND subcard_hash = $2 AND cleared = false ORDER BY received_at`,
    [cardHash, subcardHash]
  );
  return rows;
}

/** Records the relay UUID a message was most recently handed to (Step 4.4). */
export async function setDeliveryUuid(pool: Pool, messageId: string, uuid: string): Promise<void> {
  await pool.query('UPDATE message_queue SET delivery_uuid = $1 WHERE id = $2', [uuid, messageId]);
}

/**
 * Clears the message a delivery UUID most recently carried (Step 4.5).
 * Returns false if the UUID is unknown or its message was already cleared
 * — both map to 404 at the route layer.
 */
export async function clearMessageByDeliveryUuid(pool: Pool, uuid: string): Promise<boolean> {
  const { rowCount } = await pool.query(
    `UPDATE message_queue SET cleared = true, cleared_at = now() WHERE delivery_uuid = $1 AND cleared = false`,
    [uuid]
  );
  return (rowCount ?? 0) > 0;
}

export interface HeldMessageCount {
  card_hash: string;
  count: number;
}

/** Operator visibility (strategic-plan.md §Goal 5) — uncleared message counts per card. No subcard_hash, no payload, no device data. */
export async function countHeldMessagesPerCard(pool: Pool): Promise<HeldMessageCount[]> {
  const { rows } = await pool.query<{ card_hash: string; count: string }>(
    `SELECT card_hash, count(*) FROM message_queue WHERE cleared = false GROUP BY card_hash ORDER BY card_hash`
  );
  return rows.map((r) => ({ card_hash: r.card_hash, count: Number(r.count) }));
}
