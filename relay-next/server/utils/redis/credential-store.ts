// Device credential store — relay_data_model.md §8. Ported against the
// spec directly (reference `relay/src/utils/storage/redis.ts` is not
// present in this checkout — see Phase 2 report).

import type { RedisClient } from './resp-client';
import { credentialKey } from './keys';
import { DEFAULT_UUID_TTL_SECONDS } from './uuid-store';

export interface CredentialRecord {
  push_token: string;
  app_id: string;
  created_at: string;
}

export class CredentialStore {
  constructor(
    private redis: RedisClient,
    private ttlSeconds: number = DEFAULT_UUID_TTL_SECONDS
  ) {}

  async create(deviceCredential: string, record: CredentialRecord): Promise<void> {
    const key = credentialKey(deviceCredential);
    await this.redis.hset(key, {
      push_token: record.push_token,
      app_id: record.app_id,
      created_at: record.created_at,
    });
    await this.redis.expire(key, this.ttlSeconds);
  }

  async get(deviceCredential: string): Promise<CredentialRecord | null> {
    const fields = await this.redis.hgetall(credentialKey(deviceCredential));
    if (!fields || Object.keys(fields).length === 0) return null;
    return {
      push_token: fields.push_token ?? '',
      app_id: fields.app_id ?? '',
      created_at: fields.created_at ?? '',
    };
  }

  /** Replenishment path (relay_data_model.md §8.3): refresh push_token and TTL. */
  async refresh(deviceCredential: string, pushToken: string): Promise<void> {
    const key = credentialKey(deviceCredential);
    await this.redis.hset(key, { push_token: pushToken });
    await this.redis.expire(key, this.ttlSeconds);
  }

  async exists(deviceCredential: string): Promise<boolean> {
    return this.redis.exists(credentialKey(deviceCredential));
  }
}
