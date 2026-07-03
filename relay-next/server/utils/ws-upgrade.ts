// Shared Redis-side validation for GET /ws/{uuid} (relay.md §7.3 steps
// 1-4, relay_data_model.md §10.3 "Opening a connection" steps 1 and 3).
// Factored out so both server/api/ws/[uuid].get.ts (node-server; also the
// unit-test surface for this logic) and server/cloudflare-entry.ts
// (the hand-rolled Cloudflare Worker entry that actually forwards to the
// Durable Object) call the identical implementation rather than
// maintaining two copies that could drift.

import type { RedisClient } from './redis/resp-client';
import { UuidStore } from './redis/uuid-store';
import { isValidUuidV4 } from './ids';
import type { RelayErrorCode } from './http-errors';

export type WsUpgradeValidationResult =
  | { ok: true; deviceCredential: string }
  | { ok: false; errorCode: RelayErrorCode; wsCloseCode: number; message: string };

/**
 * Validates and performs the unused -> active transition. Does NOT touch
 * any Durable Object — that's the caller's responsibility, and only after
 * this returns `ok: true` (relay_data_model.md §10.3 step 3: "If step 1
 * fails ... the DO is never invoked").
 */
export async function validateAndActivateUuid(
  redis: RedisClient,
  uuid: string | undefined
): Promise<WsUpgradeValidationResult> {
  if (!uuid || !isValidUuidV4(uuid)) {
    return {
      ok: false,
      errorCode: 'INVALID_UUID',
      wsCloseCode: 4000,
      message: 'Path parameter is not a valid UUID v4',
    };
  }

  const uuidStore = new UuidStore(redis);
  const record = await uuidStore.get(uuid);
  if (!record) {
    return {
      ok: false,
      errorCode: 'UNKNOWN_UUID',
      wsCloseCode: 4004,
      message: 'UUID not found',
    };
  }
  if (record.status !== 'unused') {
    return {
      ok: false,
      errorCode: 'UUID_CONSUMED',
      wsCloseCode: 4010,
      message: `UUID is ${record.status}`,
    };
  }

  // Plain conditional update, not the CAS Lua script — relay_data_model.md
  // §7.3's simplification note (see uuid-store.ts's simpleTransition doc).
  const transition = await uuidStore.simpleTransition(uuid, 'unused', 'active');
  if (!transition.ok) {
    return {
      ok: false,
      errorCode: 'UUID_CONSUMED',
      wsCloseCode: 4010,
      message:
        transition.error === 'NOT_FOUND'
          ? 'UUID not found'
          : `UUID is ${transition.currentStatus}`,
    };
  }

  return { ok: true, deviceCredential: record.device_credential };
}
