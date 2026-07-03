// Error codes/status mapping — relay.md §10.

import { createError, getHeader, type H3Event } from 'h3';

export type RelayErrorCode =
  | 'MISSING_FIELD'
  | 'INVALID_COUNT'
  | 'INVALID_UUID'
  | 'UNKNOWN_APP'
  | 'UNKNOWN_UUID'
  | 'UUID_CONSUMED'
  | 'ENDPOINT_DEPRECATED'
  | 'MISSING_CREDENTIAL'
  | 'INVALID_CREDENTIAL'
  | 'PUSH_FAILED'
  | 'INTERNAL_ERROR';

const STATUS_BY_CODE: Record<RelayErrorCode, number> = {
  MISSING_FIELD: 400,
  INVALID_COUNT: 400,
  INVALID_UUID: 400,
  UNKNOWN_APP: 404,
  UNKNOWN_UUID: 404,
  UUID_CONSUMED: 410,
  ENDPOINT_DEPRECATED: 410,
  MISSING_CREDENTIAL: 401,
  INVALID_CREDENTIAL: 401,
  PUSH_FAILED: 502,
  INTERNAL_ERROR: 500,
};

export function relayError(code: RelayErrorCode, message: string) {
  return createError({
    statusCode: STATUS_BY_CODE[code],
    statusMessage: code,
    data: { error: code, message },
  });
}

/**
 * Extracts the device credential from `Authorization: Bearer <token>`.
 * Uses h3's `getHeader`, which is the portable accessor across both
 * presets (unlike `event.node.req`, which is node-server-specific).
 */
export function extractBearerCredential(event: H3Event): string | null {
  const header = getHeader(event, 'authorization');
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match?.[1] ?? null;
}
