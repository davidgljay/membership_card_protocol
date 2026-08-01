/**
 * Direct-to-Synapse test-user registration and card-gated room creation for
 * dev-tests' matrix-relay suites, deliberately bypassing wallet-service's
 * Application Service bridge -- ported from
 * integration_tests/suites/support/matrixAdmin.ts unchanged in logic, only
 * config sourcing changed (`DEV_*` env vars via this file, not
 * `SUITE_*`/localhost defaults).
 *
 * Requires a dev Matrix/Synapse deployment reachable at `DEV_SYNAPSE_URL`,
 * with admin shared-secret registration enabled and
 * `DEV_MATRIX_REGISTRATION_SHARED_SECRET` matching that deployment's own
 * configured secret. Per wallet-service/DEPLOYMENT.md's "Out of scope"
 * section, the Matrix/Synapse subsystem deploys separately from
 * wallet-service's own Worker deploy (a docker-compose service, not
 * currently covered by scripts/deploy-all.sh) -- confirm this exists before
 * running the suites that import this file. See
 * plans/deployment/phase-3-summary.md's outstanding items.
 */

import { createHmac, randomBytes } from 'node:crypto';

export const SYNAPSE_BASE_URL = (process.env.DEV_SYNAPSE_URL ?? '').replace(/\/$/, '');
export const MATRIX_SERVER_NAME = process.env.DEV_MATRIX_SERVER_NAME ?? '';
export const MATRIX_ENFORCEMENT_USER_ID =
  process.env.DEV_MATRIX_ENFORCEMENT_USER_ID ?? `@enforcement:${MATRIX_SERVER_NAME}`;
const REGISTRATION_SHARED_SECRET = process.env.DEV_MATRIX_REGISTRATION_SHARED_SECRET ?? '';

function requireMatrixConfig(): void {
  if (!SYNAPSE_BASE_URL || !MATRIX_SERVER_NAME || !REGISTRATION_SHARED_SECRET) {
    throw new Error(
      'matrixAdmin.ts requires DEV_SYNAPSE_URL, DEV_MATRIX_SERVER_NAME, and ' +
        'DEV_MATRIX_REGISTRATION_SHARED_SECRET -- see dev-tests/.env.example and ' +
        "wallet-service/DEPLOYMENT.md's Matrix/Synapse notes.",
    );
  }
}

export interface RegisteredMatrixUser {
  userId: string;
  accessToken: string;
}

/** Synapse's admin/v1/register HMAC flow (https://element-hq.github.io/synapse/latest/admin_api/register_api.html). */
export async function registerMatrixUserViaSharedSecret(localpart: string): Promise<RegisteredMatrixUser> {
  requireMatrixConfig();
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

/** Mirrors wallet-service/src/matrix/room-creation.ts's createMatrixRoomViaSynapse -- see this file's header comment for why it's duplicated, not imported. */
export async function createCardGatedRoom(params: CreateCardGatedRoomParams): Promise<CreateCardGatedRoomResult> {
  requireMatrixConfig();
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

/**
 * Submits the `io.cardprotocol.room_creator_attestation` custom state
 * event that gets the room creator's own membership registered -- without
 * this, a room's creator can never post in their own card-gated room.
 */
export async function submitRoomCreatorAttestation(
  roomId: string,
  creatorAccessToken: string,
  attestation: unknown
): Promise<Response> {
  return fetch(
    `${SYNAPSE_BASE_URL}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/io.cardprotocol.room_creator_attestation`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${creatorAccessToken}` },
      body: JSON.stringify(attestation),
    }
  );
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
