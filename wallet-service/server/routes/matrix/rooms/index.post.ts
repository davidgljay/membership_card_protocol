/**
 * POST /matrix/rooms — creates a card-gated Matrix room
 * (matrix-implementation-plan.md Phase 4 Step 16;
 * specs/object_specs/matrix_room.md §Room Creation).
 *
 * Thin H3 adapter — logic lives in src/matrix/provisioning.ts (ensures the
 * creator's shadow account exists, Step 15b), src/matrix/token-minting.ts
 * (mints the creator's own Matrix access token, reused verbatim from Step
 * 15c rather than re-implemented here), and src/matrix/room-creation.ts
 * (the Synapse `/createRoom` call, including the enforcement-account
 * power-levels grant) — same thin-route/pure-src split as
 * server/routes/matrix/token.post.ts. The room-index append uses
 * server/db/matrix-rooms.ts, the same authenticated-write /
 * unauthenticated-read table shape as server/db/routing.ts +
 * server/routes/bindings/index.get.ts.
 *
 * Session-token authenticated. Unlike token.post.ts (which always mints
 * for the caller's own session.card_hash implicitly and never reads a
 * card_hash from the body), this endpoint's request shape
 * (specs/object_specs/matrix_room.md) names `card_hash` explicitly as a
 * body field — but it is never trusted from the body alone: it must equal
 * session.card_hash or the request is rejected with 403. A caller can
 * therefore never create a room "as" any shadow account but their own.
 */

import { requireSessionToken, AuthError } from '../../../utils/auth.js';
import { createKvStore } from '../../../utils/kv-store.js';
import { getPool } from '../../../db/client.js';
import { insertRoomIndexEntry } from '../../../db/matrix-rooms.js';
import { loadConfig } from '../../../../src/config.js';
import { provisionShadowAccount } from '../../../../src/matrix/provisioning.js';
import { mintMatrixAccessToken } from '../../../../src/matrix/token-minting.js';
import {
  createMatrixRoomViaSynapse,
  assertCardHashBelongsToSession,
  RoomCreatorAuthorizationError,
} from '../../../../src/matrix/room-creation.js';

interface CreateRoomRequestBody {
  card_hash?: string;
  policy_id?: string;
  name?: string;
  topic?: string;
}

export default defineEventHandler(async (event) => {
  let session;
  try {
    session = await requireSessionToken(event);
  } catch (err) {
    if (err instanceof AuthError) {
      throw createError({ statusCode: err.statusCode, statusMessage: err.message });
    }
    throw err;
  }

  const body = await readBody<CreateRoomRequestBody>(event);
  if (!body?.card_hash || !body?.policy_id) {
    throw createError({ statusCode: 400, statusMessage: 'card_hash and policy_id are required.' });
  }

  // card_hash is a request-body field per matrix_room.md's request shape,
  // but must belong to the authenticated session — never trusted from the
  // body alone, same "verify against the session, don't take it on faith"
  // rule every other card_hash-bearing endpoint in this service follows.
  try {
    assertCardHashBelongsToSession(session.card_hash, body.card_hash);
  } catch (err) {
    if (err instanceof RoomCreatorAuthorizationError) {
      throw createError({ statusCode: 403, statusMessage: err.message });
    }
    throw err;
  }

  const config = loadConfig();

  const { matrixUserId } = await provisionShadowAccount({
    cardHash: session.card_hash,
    serverName: config.MATRIX_SERVER_NAME,
    synapseBaseUrl: config.MATRIX_SYNAPSE_URL,
  });

  const kv = createKvStore();
  const { matrixAccessToken } = await mintMatrixAccessToken({
    matrixUserId,
    synapseBaseUrl: config.MATRIX_SYNAPSE_URL,
    kv,
  });

  const { roomId, matrixAlias } = await createMatrixRoomViaSynapse({
    creatorMatrixUserId: matrixUserId,
    creatorAccessToken: matrixAccessToken,
    synapseBaseUrl: config.MATRIX_SYNAPSE_URL,
    policyId: body.policy_id,
    enforcementUserId: config.MATRIX_ENFORCEMENT_USER_ID,
    name: body.name,
    topic: body.topic,
  });

  const pool = getPool();
  await insertRoomIndexEntry(pool, {
    room_id: roomId,
    policy_id: body.policy_id,
    created_at: new Date(),
  });

  return { room_id: roomId, matrix_alias: matrixAlias };
});
