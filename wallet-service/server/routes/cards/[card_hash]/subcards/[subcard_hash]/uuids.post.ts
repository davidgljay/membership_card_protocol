/**
 * POST /cards/{card_hash}/subcards/{subcard_hash}/uuids —
 * notification_relay.md v0.8 §Process 1 steps 6-8 (was
 * implementation-plan.md §Step 5.1; tightened by security-audit finding
 * (a), implementation-plan.md §Step 2.7). The device registering UUIDs
 * must prove control of the sub-card's private key: the request body is a
 * signed envelope, not a bare UUID array.
 *
 * This route is a thin H3 adapter — all the actual logic (envelope
 * parsing, path/payload matching, on-chain pubkey resolution, signature
 * verification, replay checks, and the original registration +
 * retransmission behavior) lives in
 * ../../../../../../src/routes/subcard-uuid-registration.ts, which is
 * plain async logic with no H3 dependency so it's directly unit-testable
 * (see wallet-service/test/subcard-uuid-registration.test.ts) — matching
 * this codebase's existing convention of testing logic modules rather
 * than route files (route files depend on Nitro's build-time
 * defineEventHandler/getRouterParam/readBody auto-imports, which aren't
 * available under plain vitest).
 *
 * What this endpoint intentionally still does NOT do: authenticate which
 * *device* is registering (only that whoever holds the sub-card private
 * key is) — that's the unlinkability property from the original Step 5.1
 * design, preserved here. The fix closes "anyone who merely knows a
 * card_hash/subcard_hash pair," not "which device."
 */

import { getPool } from '../../../../../db/client.js';
import { loadConfig } from '../../../../../../src/config.js';
import {
  handleUuidRegistration,
  type RawUuidRegistrationBody,
} from '../../../../../../src/routes/subcard-uuid-registration.js';

export default defineEventHandler(async (event) => {
  const cardHash = getRouterParam(event, 'card_hash');
  const subcardHash = getRouterParam(event, 'subcard_hash');
  const rawBody = await readBody<RawUuidRegistrationBody>(event);

  const outcome = await handleUuidRegistration({
    pool: getPool(),
    config: loadConfig(),
    cardHashParam: cardHash,
    subcardHashParam: subcardHash,
    rawBody,
  });

  if (!outcome.ok) {
    throw createError({ statusCode: outcome.statusCode, statusMessage: outcome.statusMessage });
  }

  setResponseStatus(event, 204);
  return null;
});
