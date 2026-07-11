// Message store — relay_data_model.md §3. Keyed by `device_credential`, NOT
// `push_token` — this was a corrected bug from v0.5 (see §3.1's note in the
// spec: push-token-keying would break the isolation guarantee in §8.1's
// threat model). Ported against the spec directly.

import type { RedisClient } from './resp-client';
import { messagesKey } from './keys';
import { DEFAULT_UUID_TTL_SECONDS } from './uuid-store';

export interface MessageEntry {
  uuid: string;
  blob: string;
  wallet_url: string;
  received_at: string;
}

// Lua script for atomic read-and-clear (relay_data_model.md §3.2 "Retrieve
// and clear"). Needs to be atomic so a concurrent RPUSH landing between
// LRANGE and DEL isn't silently dropped without being returned to anyone —
// with this script, either it lands before LRANGE (and is returned+cleared)
// or after DEL (and survives for the next GET /pending).
const READ_AND_CLEAR_SCRIPT = `
local key = KEYS[1]
local items = redis.call('LRANGE', key, 0, -1)
redis.call('DEL', key)
return items
`;

export class MessageStore {
  constructor(
    private redis: RedisClient,
    private ttlSeconds: number = DEFAULT_UUID_TTL_SECONDS
  ) {}

  /** Store a message on POST /deliver/{uuid} (relay_data_model.md §3.2). */
  async append(deviceCredential: string, entry: MessageEntry): Promise<void> {
    const key = messagesKey(deviceCredential);
    await this.redis.rpush(key, JSON.stringify(entry));
    // TTL refreshed on each push — relay_data_model.md §3.3.
    await this.redis.expire(key, this.ttlSeconds);
  }

  /** Atomically read and clear on GET /pending (relay_data_model.md §3.2). */
  async readAndClear(deviceCredential: string): Promise<MessageEntry[]> {
    const key = messagesKey(deviceCredential);
    const result = await this.redis.eval(READ_AND_CLEAR_SCRIPT, [key], []);
    if (!Array.isArray(result)) return [];
    return result.map((raw) => JSON.parse(raw as string) as MessageEntry);
  }
}
