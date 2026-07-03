// Shared credential validation for GET /sse (relay.md §7.4 steps 1-2).
// Same factoring rationale as ws-upgrade.ts.

import type { RedisClient } from './redis/resp-client';
import { CredentialStore } from './redis/credential-store';
import type { RelayErrorCode } from './http-errors';

export type SseUpgradeValidationResult =
  | { ok: true; pushToken: string }
  | { ok: false; errorCode: RelayErrorCode; message: string };

export async function validateSseCredential(
  redis: RedisClient,
  deviceCredential: string | null
): Promise<SseUpgradeValidationResult> {
  if (!deviceCredential) {
    return { ok: false, errorCode: 'MISSING_CREDENTIAL', message: 'No Authorization header' };
  }
  const credentialStore = new CredentialStore(redis);
  const record = await credentialStore.get(deviceCredential);
  if (!record) {
    return {
      ok: false,
      errorCode: 'INVALID_CREDENTIAL',
      message: 'Device credential unknown or expired',
    };
  }
  return { ok: true, pushToken: record.push_token };
}
