/**
 * DELETE /cards/{card_hash}/subcards/{subcard_hash} —
 * notification_relay.md v0.9 §Multi-Device Support "Deregistration" (was
 * implementation-plan.md §Step 5.2, unauthenticated; tightened by the same
 * correction that generalized ../uuids.post.ts's signed-envelope pattern
 * to this endpoint). Device removes its UUID pool for a subcard (app
 * uninstall, card removal, or key rotation) by proving control of the
 * subcard's private key — same signed-envelope shape as UUID registration,
 * minus the `uuids` field. Marks all UUIDs for this subcard as consumed;
 * 404 if this subcard was never registered at all.
 *
 * This route is a thin H3 adapter — all the actual logic (envelope
 * parsing, path/payload matching, on-chain pubkey resolution, signature
 * verification, replay checks, and the original deregistration behavior)
 * lives in ../../../../../../src/routes/subcard-deregistration.ts, plain
 * async logic with no H3 dependency so it's directly unit-testable (see
 * wallet-service/test/subcard-deregistration.test.ts) — same convention as
 * uuids.post.ts / subcard-uuid-registration.ts.
 *
 * This wallet-service-local deregistration is independent of on-chain
 * sub-card revocation (SubCardEntry.active, governed by
 * specs/process_specs/subcard_creation_policy.md) in both directions: it
 * neither reads nor sets that flag. A deregistered-then-re-registering
 * subcard is fully functional again — see
 * ../../../../../../src/auth/subcard-uuid-signature.ts's
 * resolveSubcardPubkey doc comment for the full rationale.
 */

import { getPool } from '../../../../../db/client.js';
import { loadConfig } from '../../../../../../src/config.js';
import {
  handleSubcardDeregistration,
  type RawSubcardDeregistrationBody,
} from '../../../../../../src/routes/subcard-deregistration.js';

export default defineEventHandler(async (event) => {
  const cardHash = getRouterParam(event, 'card_hash');
  const subcardHash = getRouterParam(event, 'subcard_hash');
  const rawBody = await readBody<RawSubcardDeregistrationBody>(event);

  const outcome = await handleSubcardDeregistration({
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
