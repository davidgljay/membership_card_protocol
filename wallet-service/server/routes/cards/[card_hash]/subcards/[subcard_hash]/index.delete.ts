/**
 * DELETE /cards/{card_hash}/subcards/{subcard_hash} — implementation-plan.md
 * §Step 5.2. Device removes its UUID pool for a subcard (app uninstall,
 * card removal). Marks all UUIDs for this subcard as consumed; 404 if this
 * subcard was never registered at all.
 */

import { getPool } from '../../../../../db/client.js';
import { subcardHasAnyHistory, consumeAllForSubcard } from '../../../../../db/uuid-pools.js';

export default defineEventHandler(async (event) => {
  const cardHash = getRouterParam(event, 'card_hash');
  const subcardHash = getRouterParam(event, 'subcard_hash');
  if (!cardHash || !subcardHash) {
    throw createError({ statusCode: 400, statusMessage: 'card_hash and subcard_hash are required.' });
  }

  const pool = getPool();
  const everRegistered = await subcardHasAnyHistory(pool, cardHash, subcardHash);
  if (!everRegistered) {
    throw createError({ statusCode: 404, statusMessage: 'Subcard not registered.' });
  }

  await consumeAllForSubcard(pool, cardHash, subcardHash);

  console.info(`[wallet-service] subcard uuid pool deregistered card_hash=${cardHash}`);

  setResponseStatus(event, 204);
  return null;
});
