/**
 * Direct-to-Synapse test-user registration and card-gated room creation for
 * `suites/matrix-relay/`, deliberately bypassing `wallet-service`'s
 * Application Service bridge (`POST /matrix/token` / `POST /matrix/rooms`).
 *
 * Why bypass wallet-service here: `integration_tests/docker-compose.yml`'s
 * Synapse has no Application Service registered (its
 * `homeserver.yaml.template`'s own header comment says as much — "Once
 * wallet-service joins the stack, this can gain app_service_config_files
 * back," never done) and `wallet-service`'s AS token is read from a local
 * file (`readAppServiceAsToken`, `wallet-service/src/matrix/
 * appservice-tokens.ts`) that isn't baked into or mounted in this stack's
 * wallet-service image either — wiring both up is a real, separate
 * infrastructure project, not something this suite should take on to get
 * a Matrix room to exist. Fortunately nothing about testing the *policy
 * module's* join/post authorization logic requires going through
 * wallet-service at all: `deriveMatrixUserId`/`verifyMatrixUserIdBinding`
 * (`matrix_encryption.md §3`) are pure functions of a card's keypair, and
 * Synapse's own admin shared-secret registration
 * (`homeserver.yaml.template`'s `enable_registration` +
 * `registration_shared_secret`, already wired for exactly this purpose —
 * see its own comment) can register a user at *any* localpart, including
 * one shaped exactly like a real shadow account. A user registered this
 * way is indistinguishable, from the policy module's point of view, from
 * one wallet-service would have provisioned — the module only ever
 * verifies the attestation and the Matrix ID's shape, never how the
 * account came to exist.
 *
 * `createCardGatedRoom` below mirrors `wallet-service/src/matrix/
 * room-creation.ts`'s `createMatrixRoomViaSynapse` byte-for-byte (same
 * `initial_state` array) rather than importing it — wallet-service has no
 * `exports`/build output making it usable as a library dependency, and
 * duplicating ~15 lines of request-shaping is lower-risk than wiring a
 * cross-package import into an app that was never meant to be imported.
 * If `room-creation.ts`'s initial_state ever changes, this needs updating
 * to match — both are `matrix_room.md §Room Creation`'s single source of
 * truth for what a card-gated room's initial state must contain.
 */

import { createHmac, randomBytes } from 'node:crypto';

export const SYNAPSE_BASE_URL = (process.env.SUITE_SYNAPSE_URL ?? 'http://localhost:8008').replace(/\/$/, '');
export const MATRIX_SERVER_NAME = process.env.SUITE_MATRIX_SERVER_NAME ?? 'matrix.integration-tests.local';
export const MATRIX_ENFORCEMENT_USER_ID =
  process.env.SUITE_MATRIX_ENFORCEMENT_USER_ID ?? `@enforcement:${MATRIX_SERVER_NAME}`;
// Must match integration_tests/docker-compose.yml's synapse-init
// MATRIX_REGISTRATION_SHARED_SECRET (env/synapse/init.sh writes this fixed,
// non-random value into the Synapse volume specifically so a test-runner
// process — which has no access to that Docker volume — can know it too).
const REGISTRATION_SHARED_SECRET =
  process.env.SUITE_MATRIX_REGISTRATION_SHARED_SECRET ?? 'integration-tests-dev-registration-shared-secret';

export interface RegisteredMatrixUser {
  userId: string;
  accessToken: string;
}

/** Synapse's admin/v1/register HMAC flow (https://element-hq.github.io/synapse/latest/admin_api/register_api.html). */
export async function registerMatrixUserViaSharedSecret(localpart: string): Promise<RegisteredMatrixUser> {
  const nonceRes = await fetch(`${SYNAPSE_BASE_URL}/_synapse/admin/v1/register`);
  if (!nonceRes.ok) {
    throw new Error(`registerMatrixUserViaSharedSecret: GET nonce failed: HTTP ${nonceRes.status}`);
  }
  const { nonce } = (await nonceRes.json()) as { nonce: string };

  const password = randomBytes(16).toString('hex');
  const mac = createHmac('sha1', REGISTRATION_SHARED_SECRET)
    .update(`${nonce}\0${localpart}\0${password}\0notadmin`)
    .digest('hex');

  const res = await fetch(`${SYNAPSE_BASE_URL}/_synapse/admin/v1/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nonce, username: localpart, password, mac, admin: false }),
  });
  if (!res.ok) {
    throw new Error(`registerMatrixUserViaSharedSecret: POST register failed for ${localpart}: HTTP ${res.status}: ${await res.text()}`);
  }
  const body = (await res.json()) as { user_id: string; access_token: string };
  return { userId: body.user_id, accessToken: body.access_token };
}

export interface CreateCardGatedRoomParams {
  creatorMatrixUserId: string;
  creatorAccessToken: string;
  policyId: string;
  name?: string;
  topic?: string;
}

export interface CreateCardGatedRoomResult {
  roomId: string;
}

const ROOM_KICK_POWER_LEVEL = 50;
const ROOM_CREATOR_POWER_LEVEL = 100;

/** Mirrors wallet-service/src/matrix/room-creation.ts's createMatrixRoomViaSynapse — see this file's header comment for why it's duplicated, not imported. */
export async function createCardGatedRoom(params: CreateCardGatedRoomParams): Promise<CreateCardGatedRoomResult> {
  const initialState = [
    { type: 'm.room.join_rules', state_key: '', content: { join_rule: 'public' } },
    { type: 'm.room.encryption', state_key: '', content: { algorithm: 'm.megolm.v1.aes-sha2' } },
    { type: 'm.card.policy', state_key: '', content: { policy_id: params.policyId } },
    {
      type: 'm.room.power_levels',
      state_key: '',
      content: {
        users: {
          [params.creatorMatrixUserId]: ROOM_CREATOR_POWER_LEVEL,
          [MATRIX_ENFORCEMENT_USER_ID]: ROOM_KICK_POWER_LEVEL,
        },
      },
    },
  ];

  const body: Record<string, unknown> = { preset: 'private_chat', initial_state: initialState };
  if (params.name !== undefined) body['name'] = params.name;
  if (params.topic !== undefined) body['topic'] = params.topic;

  const res = await fetch(`${SYNAPSE_BASE_URL}/_matrix/client/v3/createRoom`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${params.creatorAccessToken}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`createCardGatedRoom: /createRoom failed for ${params.creatorMatrixUserId}: HTTP ${res.status}: ${await res.text()}`);
  }
  const responseBody = (await res.json()) as { room_id?: string };
  if (!responseBody.room_id) {
    throw new Error(`createCardGatedRoom: /createRoom response missing room_id`);
  }
  return { roomId: responseBody.room_id };
}

export async function fetchRoomState(roomId: string, eventType: string, accessToken: string): Promise<unknown> {
  const res = await fetch(
    `${SYNAPSE_BASE_URL}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/${eventType}`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  if (!res.ok) {
    throw new Error(`fetchRoomState: GET state/${eventType} failed for ${roomId}: HTTP ${res.status}`);
  }
  return res.json();
}
