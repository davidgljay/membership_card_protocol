/**
 * POST /matrix/discover-rooms — specs/process_specs/room_discovery.md §3;
 * matrix-implementation-plan.md Phase 4 Step 16c.
 *
 * Server-hosted room discovery: **secondary/fallback path**, not the
 * default. `client-sdk`'s `discoverRooms` (Step 16b,
 * `client-sdk/packages/client-sdk/src/matrix/discovery.ts`) is the intended
 * default — a client should attempt that local RPC/IPFS chain-walk first
 * and fall back to this endpoint only when local RPC/IPFS access genuinely
 * isn't available (e.g. a constrained mobile client), per §3: "Not the
 * default. Client SDKs should attempt the local path first ... not as a
 * convenience shortcut when it is." Nothing here changes or supersedes
 * that client-side path.
 *
 * Authenticated via the existing session-token auth (`requireSessionToken`,
 * same as `token.post.ts`). `session.card_hash` is the identity this
 * endpoint answers "what can this card see" for — never a request-body
 * override, so a caller can't ask on behalf of a card_hash they don't
 * actually hold a session for.
 *
 * **Corrected 2026-07-12 — the request body now carries a signed envelope,
 * not just an implicit identity.** The original version of this endpoint
 * assumed `discoverEligibleRooms` could chain-walk from `session.card_hash`
 * alone; it can't — a real chain-walk needs the card's pubkey (to decrypt
 * `CardDocument` content), which `wallet-service` never holds (private
 * keys, and the pubkey derivation that depends on holding them for signing,
 * stay client-side by design). The caller must submit an already-signed
 * envelope in the request body — built via `client-sdk`'s exported
 * `buildRoomDiscoveryEnvelope` (`client-sdk/packages/client-sdk/src/matrix/
 * discovery.ts`) — the same envelope shape that function's own
 * (now-corrected) `discoverRooms` uses for the client-side path. Signing
 * needs only the local private key, no RPC/IPFS access, so this remains a
 * legitimate fallback for a client that can't chain-walk locally but can
 * still sign locally. `discoverEligibleRooms` (`src/matrix/room-discovery.ts`)
 * verifies the envelope's signature is genuinely valid and that its
 * recovered `signer_card` matches `session.card_hash` before doing anything
 * with it — see that module's header for the full reasoning.
 *
 * Runs `discoverEligibleRooms` — the identical evaluator + any_of logic as
 * client-sdk's `discoverRooms` (Step 16b), fed by this service's own
 * `matrix_room_index` table (`db/matrix-rooms.ts`'s `listRoomIndex`, Step
 * 16/16a) instead of an HTTP round-trip to its own `GET /matrix/room-index`.
 * See `src/matrix/card-chain-verifier.ts` for the current gap in
 * *production* chain-walking wiring (no RpcProvider implementation covering
 * the full verifier surface exists anywhere in this codebase yet) — the
 * algorithm itself is complete and tested against an injected
 * `CardChainVerifier`.
 *
 * **Privacy constraint (room_discovery.md §3) — the entire reason this is
 * a secondary path rather than the default:** using this endpoint tells
 * `wallet-service` "this card_hash is interested in room eligibility right
 * now," a signal the client-side path never produces. The only state this
 * handler keeps as a result is a short-window abuse rate-limit counter
 * (`kvKeys.discoverRoomsRate`, via the same `enforceRateLimit` /
 * `checkSlidingWindow` sliding-window mechanism every other rate limit in
 * this service uses — no new abuse-tracking machinery invented here). This
 * handler makes **no database write of any kind** — `listRoomIndex` is a
 * read, `discoverEligibleRooms` is a pure read-and-compute function (see
 * its own header) — so there is no durable per-card record of which rooms
 * were asked about, only the ephemeral (TTL'd, counter-only) KV rate-limit
 * key.
 *
 * Response shape: `{ room_ids: string[] }` — room_discovery.md §3 documents
 * the *client-side* `discoverRooms` return value as a bare `[room_id, ...]`
 * array, but doesn't specify an exact wire shape for this endpoint's HTTP
 * response body. An object envelope (rather than a bare array as the HTTP
 * body) is chosen for consistency with every other JSON response in this
 * service (`token.post.ts`, `room-index.get.ts`, `rooms/index.post.ts` all
 * return objects, never a bare top-level array) and to leave room for
 * future response-level metadata without a breaking shape change.
 */

import type { SignedMessageEnvelope } from '@membership-card-protocol/verifier';
import { requireSessionToken, AuthError } from '../../utils/auth.js';
import { enforceRateLimit } from '../../utils/enforce-rate-limit.js';
import { kvKeys } from '../../../src/kv.js';
import { loadConfig } from '../../../src/config.js';
import { getPool } from '../../db/client.js';
import { listRoomIndex } from '../../db/matrix-rooms.js';
import { discoverEligibleRooms, InvalidDiscoveryEnvelopeError } from '../../../src/matrix/room-discovery.js';
import { createCardChainVerifier } from '../../../src/matrix/card-chain-verifier.js';

// room_discovery.md §3 doesn't specify a rate-limit number; this picks a
// generous-for-legitimate-use, cheap-to-abuse-detect window, the same
// order of magnitude as this service's other per-card rate limits
// (recoveryInitiationRate: 3/24h is much stricter because recovery is
// higher-stakes; this is a read-only convenience fallback, so it's closer
// to challengeRate's cadence) — a card polling this fallback every few
// seconds while genuinely offline-RPC-constrained is expected use; a card
// hammering it hundreds of times a minute is not.
const DISCOVER_ROOMS_LIMIT = 30;
const DISCOVER_ROOMS_WINDOW_SECONDS = 60;

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

  await enforceRateLimit(
    event,
    kvKeys.discoverRoomsRate(session.card_hash),
    DISCOVER_ROOMS_LIMIT,
    DISCOVER_ROOMS_WINDOW_SECONDS
  );

  const body = await readBody<{ envelope?: SignedMessageEnvelope }>(event);
  if (!body?.envelope) {
    throw createError({ statusCode: 400, statusMessage: 'envelope is required.' });
  }

  const config = loadConfig();
  const pool = getPool();
  const roomIndex = await listRoomIndex(pool);
  const cardVerifier = createCardChainVerifier(config);

  let roomIds: string[];
  try {
    roomIds = await discoverEligibleRooms(
      body.envelope,
      session.card_hash,
      roomIndex.map((entry) => ({ room_id: entry.room_id, policy_id: entry.policy_id })),
      config.IPFS_GATEWAY_URL,
      cardVerifier
    );
  } catch (err) {
    if (err instanceof InvalidDiscoveryEnvelopeError) {
      throw createError({ statusCode: 403, statusMessage: err.message });
    }
    throw err;
  }

  return { room_ids: roomIds };
});
