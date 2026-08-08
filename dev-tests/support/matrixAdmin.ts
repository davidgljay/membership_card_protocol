/**
 * Direct-to-Synapse test-user registration and card-gated room creation for
 * dev-tests' matrix-relay suites, deliberately bypassing wallet-service's
 * own HTTP API -- ported from integration_tests/suites/support/matrixAdmin.ts,
 * with one deliberate divergence: registration goes through the wallet-service
 * Application Service's own as_token (`type: m.login.application_service`),
 * not Synapse's shared-secret admin API. integration_tests' local Synapse has
 * no Application Service registered at all, so shared-secret registration of
 * arbitrary `card_*` localparts works there; the dev Droplet's Synapse has
 * wallet-service's real AS registered with `exclusive: true` on
 * `@card_[0-9a-f]{64}:...` (homeserver.yaml.template's app_service_config_files),
 * and Synapse's own check_user_id_not_appservice_exclusive
 * (synapse/handlers/register.py) unconditionally rejects any *other*
 * registration path -- shared-secret included -- from claiming a username in
 * that namespace. Only the AS itself, authenticating with its own as_token,
 * is exempted from that check. This still bypasses wallet-service's HTTP API
 * (no join-flow logic runs), just not Synapse's AS-ownership check.
 *
 * Requires a dev Matrix/Synapse deployment reachable at `DEV_SYNAPSE_URL`,
 * with `DEV_MATRIX_AS_TOKEN` matching that deployment's wallet-service AS's
 * configured as_token (matrix/secrets.dev/appservice-as-token.txt on the
 * Droplet). Per wallet-service/DEPLOYMENT.md's "Out of scope" section, the
 * Matrix/Synapse subsystem deploys separately from wallet-service's own
 * Worker deploy (a docker-compose service, not currently covered by
 * scripts/deploy-all.sh) -- confirm this exists before running the suites
 * that import this file. See plans/deployment/phase-3-summary.md's
 * outstanding items.
 */

export const SYNAPSE_BASE_URL = (process.env.DEV_SYNAPSE_URL ?? '').replace(/\/$/, '');
export const MATRIX_SERVER_NAME = process.env.DEV_MATRIX_SERVER_NAME ?? '';
export const MATRIX_ENFORCEMENT_USER_ID =
  process.env.DEV_MATRIX_ENFORCEMENT_USER_ID ?? `@enforcement:${MATRIX_SERVER_NAME}`;
const AS_TOKEN = process.env.DEV_MATRIX_AS_TOKEN ?? '';

function requireMatrixConfig(): void {
  if (!SYNAPSE_BASE_URL || !MATRIX_SERVER_NAME || !AS_TOKEN) {
    throw new Error(
      'matrixAdmin.ts requires DEV_SYNAPSE_URL, DEV_MATRIX_SERVER_NAME, and ' +
        'DEV_MATRIX_AS_TOKEN -- see dev-tests/.env.example and ' +
        "wallet-service/DEPLOYMENT.md's Matrix/Synapse notes.",
    );
  }
}

export interface RegisteredMatrixUser {
  userId: string;
  accessToken: string;
}

/** Registers a user in the AS's own exclusive namespace, authenticating as the AS itself (https://spec.matrix.org/latest/application-service-api/#server-admin-style-permissions). */
export async function registerMatrixUserViaAppService(localpart: string): Promise<RegisteredMatrixUser> {
  requireMatrixConfig();
  const res = await fetch(`${SYNAPSE_BASE_URL}/_matrix/client/v3/register?kind=user`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${AS_TOKEN}` },
    body: JSON.stringify({ type: 'm.login.application_service', username: localpart }),
  });
  if (!res.ok) {
    throw new Error(`registerMatrixUserViaAppService: POST register failed for ${localpart}: HTTP ${res.status}: ${await res.text()}`);
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
