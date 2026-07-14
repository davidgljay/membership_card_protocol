import { describe, it, expect, vi } from 'vitest';
import {
  createMatrixRoomViaSynapse,
  assertCardHashBelongsToSession,
  RoomCreatorAuthorizationError,
  ROOM_KICK_POWER_LEVEL,
} from '../src/matrix/room-creation.js';

// Mocks the Synapse HTTP call rather than hitting a real homeserver, same
// convention as test/matrix-provisioning.test.ts and
// test/matrix-token-minting.test.ts (matrix-implementation-plan.md Phase 4
// Step 16).
const CREATOR_MATRIX_USER_ID = '@card_' + 'ab'.repeat(32) + ':matrix.internal';
const ENFORCEMENT_USER_ID = '@matrix-policy-bot:matrix.internal';
const SYNAPSE_BASE_URL = 'http://synapse:8008';
const ACCESS_TOKEN = 'test-creator-access-token';
const POLICY_ID = 'bafyreih6qivnk...roompredicate';
const ROOM_ID = '!xyz:matrix.internal';

describe('createMatrixRoomViaSynapse (Step 16)', () => {
  it('calls Synapse createRoom, authenticated as the creator, with all three expected initial_state entries', async () => {
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      expect(url).toBe(`${SYNAPSE_BASE_URL}/_matrix/client/v3/createRoom`);
      expect(init?.method).toBe('POST');
      expect((init?.headers as Record<string, string>)['Authorization']).toBe(`Bearer ${ACCESS_TOKEN}`);

      const body = JSON.parse(init?.body as string);
      expect(body.preset).toBe('private_chat');
      expect(Array.isArray(body.initial_state)).toBe(true);
      expect(body.initial_state).toHaveLength(3);

      const encryption = body.initial_state.find((e: { type: string }) => e.type === 'm.room.encryption');
      expect(encryption?.content).toEqual({ algorithm: 'm.megolm.v1.aes-sha2' });

      const policy = body.initial_state.find((e: { type: string }) => e.type === 'm.card.policy');
      expect(policy?.content).toEqual({ policy_id: POLICY_ID });

      const powerLevels = body.initial_state.find((e: { type: string }) => e.type === 'm.room.power_levels');
      expect(powerLevels?.content?.users?.[ENFORCEMENT_USER_ID]).toBe(ROOM_KICK_POWER_LEVEL);
      expect(powerLevels?.content?.users?.[ENFORCEMENT_USER_ID]).toBeGreaterThanOrEqual(50);
      // Creator keeps room-owner power — the enforcement account gets only
      // the minimum (kick-level) it needs, not full admin.
      expect(powerLevels?.content?.users?.[CREATOR_MATRIX_USER_ID]).toBe(100);
      expect(powerLevels?.content?.users?.[ENFORCEMENT_USER_ID]).toBeLessThan(
        powerLevels?.content?.users?.[CREATOR_MATRIX_USER_ID]
      );

      return new Response(JSON.stringify({ room_id: ROOM_ID }), { status: 200 });
    });

    const result = await createMatrixRoomViaSynapse({
      creatorMatrixUserId: CREATOR_MATRIX_USER_ID,
      creatorAccessToken: ACCESS_TOKEN,
      synapseBaseUrl: SYNAPSE_BASE_URL,
      policyId: POLICY_ID,
      enforcementUserId: ENFORCEMENT_USER_ID,
      fetchImpl,
    });

    expect(result.roomId).toBe(ROOM_ID);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('passes through name/topic when provided', async () => {
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string);
      expect(body.name).toBe('Alumni Chat');
      expect(body.topic).toBe('For verified alumni only');
      return new Response(JSON.stringify({ room_id: ROOM_ID }), { status: 200 });
    });

    await createMatrixRoomViaSynapse({
      creatorMatrixUserId: CREATOR_MATRIX_USER_ID,
      creatorAccessToken: ACCESS_TOKEN,
      synapseBaseUrl: SYNAPSE_BASE_URL,
      policyId: POLICY_ID,
      enforcementUserId: ENFORCEMENT_USER_ID,
      name: 'Alumni Chat',
      topic: 'For verified alumni only',
      fetchImpl,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('omits name/topic from the request body when not provided', async () => {
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string);
      expect(body).not.toHaveProperty('name');
      expect(body).not.toHaveProperty('topic');
      return new Response(JSON.stringify({ room_id: ROOM_ID }), { status: 200 });
    });

    await createMatrixRoomViaSynapse({
      creatorMatrixUserId: CREATOR_MATRIX_USER_ID,
      creatorAccessToken: ACCESS_TOKEN,
      synapseBaseUrl: SYNAPSE_BASE_URL,
      policyId: POLICY_ID,
      enforcementUserId: ENFORCEMENT_USER_ID,
      fetchImpl,
    });
  });

  it('returns matrixAlias when Synapse includes room_alias in the response', async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ room_id: ROOM_ID, room_alias: '#alumni:matrix.internal' }), { status: 200 })
    );

    const result = await createMatrixRoomViaSynapse({
      creatorMatrixUserId: CREATOR_MATRIX_USER_ID,
      creatorAccessToken: ACCESS_TOKEN,
      synapseBaseUrl: SYNAPSE_BASE_URL,
      policyId: POLICY_ID,
      enforcementUserId: ENFORCEMENT_USER_ID,
      fetchImpl,
    });

    expect(result.matrixAlias).toBe('#alumni:matrix.internal');
  });

  it('throws when Synapse createRoom fails', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 500 }));

    await expect(
      createMatrixRoomViaSynapse({
        creatorMatrixUserId: CREATOR_MATRIX_USER_ID,
        creatorAccessToken: ACCESS_TOKEN,
        synapseBaseUrl: SYNAPSE_BASE_URL,
        policyId: POLICY_ID,
        enforcementUserId: ENFORCEMENT_USER_ID,
        fetchImpl,
      })
    ).rejects.toThrow();
  });

  it('throws when Synapse responds 200 without a room_id', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({}), { status: 200 }));

    await expect(
      createMatrixRoomViaSynapse({
        creatorMatrixUserId: CREATOR_MATRIX_USER_ID,
        creatorAccessToken: ACCESS_TOKEN,
        synapseBaseUrl: SYNAPSE_BASE_URL,
        policyId: POLICY_ID,
        enforcementUserId: ENFORCEMENT_USER_ID,
        fetchImpl,
      })
    ).rejects.toThrow();
  });
});

describe('assertCardHashBelongsToSession (Step 16)', () => {
  const CARD_HASH = '0x' + 'ab'.repeat(32);
  const OTHER_CARD_HASH = '0x' + 'cd'.repeat(32);

  it('does not throw when the request card_hash matches the session card_hash', () => {
    expect(() => assertCardHashBelongsToSession(CARD_HASH, CARD_HASH)).not.toThrow();
  });

  it('rejects a request whose card_hash does not belong to the authenticated session', () => {
    expect(() => assertCardHashBelongsToSession(CARD_HASH, OTHER_CARD_HASH)).toThrow(
      RoomCreatorAuthorizationError
    );
  });
});

// Note: rejecting an unauthenticated request is requireSessionToken's own
// responsibility (server/utils/auth.ts), already covered by
// test/auth.test.ts; POST /matrix/rooms calls it exactly the way
// server/routes/matrix/token.post.ts does (see that file), so it isn't
// re-tested here. H3 route files (server/routes/**) rely on Nitro's
// auto-imported globals (defineEventHandler/readBody/createError) and
// aren't unit-testable outside a running Nitro instance in this codebase
// — no existing route file has a matching *.test.ts, and this one follows
// that same convention; its logic is covered here at the pure-function
// level instead (createMatrixRoomViaSynapse, assertCardHashBelongsToSession)
// plus server/db/matrix-rooms.ts's own repository test.
