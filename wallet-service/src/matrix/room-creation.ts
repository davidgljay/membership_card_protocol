/**
 * Card-gated Matrix room creation (matrix-implementation-plan.md Phase 4
 * Step 16). Called by POST /matrix/rooms after the caller's session token
 * has been verified, provisionShadowAccount (./provisioning.ts) has
 * ensured the creator's shadow account exists, and mintMatrixAccessToken
 * (./token-minting.ts) has minted a Matrix access token for that shadow
 * account — this module reuses both rather than re-implementing
 * provisioning or token minting.
 *
 * Calls Synapse's Client-Server `POST /createRoom`, authenticated as the
 * creator's own shadow account (not the Application Service), per
 * `specs/object_specs/matrix_room.md §Room Creation`:
 *
 *   - preset: "private_chat"
 *   - m.room.join_rules initial state -> "public" (see bug note below)
 *   - m.room.encryption initial state -> m.megolm.v1.aes-sha2
 *     (specs/object_specs/matrix_encryption.md)
 *   - m.card.policy initial state -> { policy_id }
 *     (specs/object_specs/matrix_room.md §The Room Predicate Document)
 *   - m.room.power_levels initial state granting the enforcement account
 *     (config.MATRIX_ENFORCEMENT_USER_ID / Step 7d) at least kick-level
 *     power
 *
 * **Bug found and fixed 2026-07-16 (Step 20 live-stack integration
 * test):** `preset: "private_chat"` alone sets Synapse's default
 * `m.room.join_rules` to `"invite"` (Synapse's own
 * `RoomCreationHandler._presets_dict`). Under an invite-only join rule,
 * Synapse's core event-authorization (`event_auth.py`, entirely separate
 * from and prior to any spam-checker callback) rejects a non-invited
 * user's `/join` with `403 "You are not invited to this room."` — before
 * `matrix_policy_module`'s `user_may_join_room`/`check_event_for_spam`
 * callbacks ever run. That silently defeated the entire card-gating
 * mechanism: `matrix_room_membership.md §1` describes the module deciding
 * allow/deny for "a card's shadow Matrix account attempt[ing] to join a
 * room" it was never separately invited to — exactly the case an
 * invite-only `join_rule` forecloses first. Confirmed live: attempting to
 * join a room created with the old `private_chat`-only config always
 * failed with the generic Matrix invite error, regardless of whether a
 * valid attestation was presented, never reaching the module at all.
 * Fixed by adding an explicit `m.room.join_rules` initial-state entry —
 * Synapse only applies a preset's default join-rules event when
 * `initial_state` doesn't already include one (`room.py`'s
 * `if (EventTypes.JoinRules, "") not in initial_state:`), so this
 * override leaves every other `private_chat` default (`history_visibility:
 * shared`, `guest_access: forbidden`) untouched while making the room
 * joinable-without-invite — gated instead by the policy module, which is
 * the whole point. The room remains unlisted in Matrix's public room
 * directory (`matrix_room.md §Room Creation`'s "not listed... consistent
 * with... 'not listed in standard Matrix public room directory'"), since
 * directory listing is controlled by a separate `visibility` `/createRoom`
 * parameter this code never sets, not by `join_rule`.
 *
 * The power_levels grant is new as of 2026-07-12 (not in the original
 * matrix_room.md text) and is load-bearing: the Synapse policy module's
 * revocation watcher (matrix-policy-module/src/matrix_policy_module/watcher.py)
 * force-removes a revoked card's shadow account from a room via an
 * in-process `ModuleApi.update_room_membership(sender=<enforcement
 * account>, ..., new_membership="leave")` call, which enforces ordinary
 * Matrix power-level auth on its `sender`. Without this grant, every
 * future force-part in a room created here fails with a permission error.
 *
 * Providing an `m.room.power_levels` entry in `initial_state` replaces the
 * preset-computed power_levels event outright (Synapse does not merge
 * initial_state overrides into preset defaults the way the separate
 * `power_level_content_override` createRoom parameter would) — so the
 * `users` map here explicitly keeps the creator at 100 (room owner) in
 * addition to granting the enforcement account kick level. Every other
 * field (ban/kick/redact/state_default/events_default/etc.) is left
 * unset deliberately: the Matrix power-level authorization algorithm
 * itself falls back to the same spec-mandated defaults
 * (kick/ban/redact: 50, state_default: 50, events_default: 0,
 * users_default: 0) that `private_chat`'s preset would have set anyway,
 * so omitting them here does not change room behavior — it just avoids
 * hand-duplicating spec-default numbers that aren't actually changing.
 * The enforcement account is deliberately granted only the minimum
 * (kick-level, not the creator's full 100) it needs to do its job — see
 * matrix-implementation-plan.md Step 16's "confirm the minimum scope
 * rather than granting more than needed" note.
 */

/**
 * Matrix's own spec-mandated default for a room's `kick` power-level
 * threshold (and, not coincidentally, `private_chat`'s preset default) —
 * not a magic number invented here. See this module's header comment for
 * why the rest of the power_levels content is left to the same
 * spec-mandated fallbacks rather than being spelled out explicitly.
 */
export const ROOM_KICK_POWER_LEVEL = 50;

/** Room owner power level Synapse's presets grant the creator by default. */
const ROOM_CREATOR_POWER_LEVEL = 100;

/**
 * Thrown when a request's `card_hash` body field does not belong to the
 * authenticated session — kept as a small, directly-testable pure
 * function (rather than inline in server/routes/matrix/rooms/index.post.ts)
 * since H3 route files rely on Nitro's auto-imported globals
 * (defineEventHandler/readBody/createError) and aren't otherwise
 * unit-testable outside a running Nitro instance, unlike this module.
 */
export class RoomCreatorAuthorizationError extends Error {}

/**
 * `specs/object_specs/matrix_room.md §Room Creation`: "`card_hash` — ...
 * Must belong to the authenticated session." Throws
 * RoomCreatorAuthorizationError if it doesn't; the H3 route maps that to a
 * 403.
 */
export function assertCardHashBelongsToSession(sessionCardHash: string, requestedCardHash: string): void {
  if (requestedCardHash !== sessionCardHash) {
    throw new RoomCreatorAuthorizationError('card_hash does not belong to the authenticated session.');
  }
}

export interface CreateMatrixRoomParams {
  /** The creating card's shadow Matrix user ID (already provisioned by provisionShadowAccount). */
  creatorMatrixUserId: string;
  /** The creator's own Matrix access token (from mintMatrixAccessToken) — createRoom is called as this user, not as the Application Service. */
  creatorAccessToken: string;
  synapseBaseUrl: string;
  /** CID of the room predicate document (specs/object_specs/matrix_room.md §The Room Predicate Document). */
  policyId: string;
  /** config.MATRIX_ENFORCEMENT_USER_ID (Step 7d's enforcement/moderation account). */
  enforcementUserId: string;
  name?: string | undefined;
  topic?: string | undefined;
  /** Defaults to the global fetch; override for tests (same convention as src/relay-client.ts). */
  fetchImpl?: typeof fetch;
}

export interface CreateMatrixRoomResult {
  roomId: string;
  /** Present only if Synapse's response includes an alias — this pass never requests one (matrix_room.md §Room Creation: aliasing is optional and not required here). */
  matrixAlias?: string | undefined;
}

interface SynapseCreateRoomResponseBody {
  room_id?: string;
  room_alias?: string;
}

export async function createMatrixRoomViaSynapse(
  params: CreateMatrixRoomParams
): Promise<CreateMatrixRoomResult> {
  const {
    creatorMatrixUserId,
    creatorAccessToken,
    synapseBaseUrl,
    policyId,
    enforcementUserId,
    name,
    topic,
  } = params;
  const fetchImpl = params.fetchImpl ?? fetch;

  const initialState = [
    {
      type: 'm.room.join_rules',
      state_key: '',
      content: { join_rule: 'public' },
    },
    {
      type: 'm.room.encryption',
      state_key: '',
      content: { algorithm: 'm.megolm.v1.aes-sha2' },
    },
    {
      type: 'm.card.policy',
      state_key: '',
      content: { policy_id: policyId },
    },
    {
      type: 'm.room.power_levels',
      state_key: '',
      content: {
        users: {
          [creatorMatrixUserId]: ROOM_CREATOR_POWER_LEVEL,
          [enforcementUserId]: ROOM_KICK_POWER_LEVEL,
        },
      },
    },
  ];

  const body: Record<string, unknown> = {
    preset: 'private_chat',
    initial_state: initialState,
  };
  if (name !== undefined) body['name'] = name;
  if (topic !== undefined) body['topic'] = topic;

  const res = await fetchImpl(`${synapseBaseUrl}/_matrix/client/v3/createRoom`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${creatorAccessToken}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    throw new Error(
      `createMatrixRoomViaSynapse: Synapse /createRoom failed for ${creatorMatrixUserId} (status ${res.status}).`
    );
  }

  const responseBody = (await res.json()) as SynapseCreateRoomResponseBody;
  if (!responseBody.room_id) {
    throw new Error(
      `createMatrixRoomViaSynapse: Synapse /createRoom response for ${creatorMatrixUserId} missing room_id.`
    );
  }

  return { roomId: responseBody.room_id, matrixAlias: responseBody.room_alias };
}
