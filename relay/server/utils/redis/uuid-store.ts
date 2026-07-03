// UUID store — relay_data_model.md §2 (key schema, fields, TTL, atomic
// transitions), §7 (state machine). Ported from `relay/src/utils/storage/
// redis.ts`'s UUID-pool functionality (reference codebase not present in
// this checkout — see Phase 2 report; built directly against the spec,
// which is authoritative per the task brief).

import type { RedisClient } from './resp-client';
import { uuidKey } from './keys';

export type UuidStatus = 'unused' | 'in_flight' | 'active' | 'consumed';

export interface UuidRecord {
  app_id: string;
  push_token: string;
  wallet_base_url: string;
  device_credential: string;
  status: UuidStatus;
  created_at: string;
}

export const DEFAULT_UUID_TTL_SECONDS = 2_592_000; // 30 days, relay_data_model.md §2.3

// The Lua CAS script — relay_data_model.md §2.4. Retained ONLY for the
// unused ⇄ in_flight ⇄ consumed transitions on the /deliver/{uuid} path
// (a plain, potentially concurrent, stateless HTTP handler). Per §7.3's
// "Simplification enabled by Durable Objects" note, the unused → active
// transition (GET /ws/{uuid}) does NOT need this script — it's a plain
// conditional update, because by the time the DO is invoked, this
// simple check-then-set in the stateless layer has already resolved any
// race on "is this UUID currently claimable."
const CAS_TRANSITION_SCRIPT = `
local current = redis.call('HGET', KEYS[1], 'status')
if current == false then
  return {err = 'NOT_FOUND'}
end
if current ~= ARGV[1] then
  return {err = 'WRONG_STATUS:' .. current}
end
redis.call('HSET', KEYS[1], 'status', ARGV[2])
return 'OK'
`;

export type CasTransitionResult =
  | { ok: true }
  | { ok: false; error: 'NOT_FOUND' }
  | { ok: false; error: 'WRONG_STATUS'; currentStatus: string };

export class UuidStore {
  constructor(
    private redis: RedisClient,
    private ttlSeconds: number = DEFAULT_UUID_TTL_SECONDS
  ) {}

  /** Creates a new UUID record in `unused` status with the standard TTL (relay_data_model.md §2.1-§2.3). */
  async create(uuid: string, record: Omit<UuidRecord, 'status'>): Promise<void> {
    const key = uuidKey(uuid);
    await this.redis.hset(key, {
      app_id: record.app_id,
      push_token: record.push_token,
      wallet_base_url: record.wallet_base_url,
      device_credential: record.device_credential,
      status: 'unused',
      created_at: record.created_at,
    });
    await this.redis.expire(key, this.ttlSeconds);
  }

  async get(uuid: string): Promise<UuidRecord | null> {
    const fields = await this.redis.hgetall(uuidKey(uuid));
    if (!fields || Object.keys(fields).length === 0) return null;
    return {
      app_id: fields.app_id ?? '',
      push_token: fields.push_token ?? '',
      wallet_base_url: fields.wallet_base_url ?? '',
      device_credential: fields.device_credential ?? '',
      status: (fields.status as UuidStatus) ?? 'unused',
      created_at: fields.created_at ?? '',
    };
  }

  /**
   * Atomic CAS transition via the Lua script (relay_data_model.md §2.4).
   * Use ONLY for the /deliver/{uuid} path's unused ⇄ in_flight ⇄ consumed
   * transitions — see this file's module doc and §7.3's simplification note
   * for why GET /ws/{uuid}'s unused → active transition uses
   * `simpleTransition` below instead.
   */
  async casTransition(
    uuid: string,
    expectedStatus: UuidStatus,
    newStatus: UuidStatus
  ): Promise<CasTransitionResult> {
    try {
      const result = await this.redis.eval(
        CAS_TRANSITION_SCRIPT,
        [uuidKey(uuid)],
        [expectedStatus, newStatus]
      );
      if (result === 'OK') return { ok: true };
      // Unreachable in practice — errors surface as thrown RespError from
      // resp-client's eval() (see readReply's `-` case), not as a returned
      // value. Kept for defensiveness against a differently-behaving
      // Redis-compatible backend.
      return { ok: false, error: 'NOT_FOUND' };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.startsWith('NOT_FOUND')) {
        return { ok: false, error: 'NOT_FOUND' };
      }
      if (message.startsWith('WRONG_STATUS:')) {
        return {
          ok: false,
          error: 'WRONG_STATUS',
          currentStatus: message.slice('WRONG_STATUS:'.length),
        };
      }
      throw err;
    }
  }

  /**
   * Plain conditional update (NOT a CAS retry loop) for the unused → active
   * transition on GET /ws/{uuid} — relay_data_model.md §7.3's
   * "Simplification enabled by Durable Objects" note: the stateless layer
   * has already resolved any race by the time this is called, and no other
   * concurrent writer can also be attempting unused → active for the same
   * UUID once this succeeds, because the Durable Object (reached only after
   * this call succeeds) is single-threaded and uniquely addressed by UUID.
   *
   * Still a check-then-set (not blind HSET) because concurrent
   * /deliver/{uuid} calls against the same UUID remain possible and must
   * not be silently clobbered.
   */
  async simpleTransition(
    uuid: string,
    expectedStatus: UuidStatus,
    newStatus: UuidStatus
  ): Promise<CasTransitionResult> {
    const record = await this.get(uuid);
    if (!record) return { ok: false, error: 'NOT_FOUND' };
    if (record.status !== expectedStatus) {
      return { ok: false, error: 'WRONG_STATUS', currentStatus: record.status };
    }
    await this.redis.hset(uuidKey(uuid), { status: newStatus });
    return { ok: true };
  }

  /** Used by the reconciliation scan (relay_data_model.md §2.5) — no CAS needed, this IS the recovery path. */
  async forceConsumed(uuid: string): Promise<void> {
    await this.redis.hset(uuidKey(uuid), { status: 'consumed' });
  }

  async exists(uuid: string): Promise<boolean> {
    return this.redis.exists(uuidKey(uuid));
  }
}
