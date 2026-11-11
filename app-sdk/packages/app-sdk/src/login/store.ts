/**
 * Pending-login storage (app_sdk.md §9a). Sites inject a LoginStore; the
 * login module keeps no state of its own. `transition` must be an atomic
 * compare-and-set so `state` values and one-time codes are single-use across
 * server instances.
 */
import type { AuthenticationRequest } from '@membership-card-protocol/verifier';

export type PendingLoginStatus = 'issued' | 'responded' | 'complete' | 'failed';

export interface PendingLogin {
  state: string;
  requestId: string;
  request: AuthenticationRequest;
  requestHash: string;
  status: PendingLoginStatus;
  createdAt: string;
  presentedCard?: string;
  code?: string;
  codeExpiresAt?: string;
  codeAttempts?: number;
}

export interface LoginStore {
  putPending(record: PendingLogin): Promise<void>;
  getPending(state: string): Promise<PendingLogin | null>;
  getByRequestId(requestId: string): Promise<PendingLogin | null>;
  /**
   * Atomically moves `state` from `from` to `to`, applying `patch`. Returns
   * false (and changes nothing) if the record is missing or not in `from`.
   */
  transition(state: string, from: PendingLoginStatus, to: PendingLoginStatus, patch?: Partial<PendingLogin>): Promise<boolean>;
  /** Updates fields without a status change (e.g. counting failed code attempts). */
  update(state: string, patch: Partial<PendingLogin>): Promise<void>;
}

/** A single-process LoginStore for development and tests. */
export function createInMemoryLoginStore(): LoginStore {
  const byState = new Map<string, PendingLogin>();
  const stateByRequest = new Map<string, string>();
  return {
    async putPending(record) {
      byState.set(record.state, { ...record });
      stateByRequest.set(record.requestId, record.state);
    },
    async getPending(state) {
      const r = byState.get(state);
      return r ? { ...r } : null;
    },
    async getByRequestId(requestId) {
      const state = stateByRequest.get(requestId);
      const r = state ? byState.get(state) : undefined;
      return r ? { ...r } : null;
    },
    async transition(state, from, to, patch = {}) {
      const r = byState.get(state);
      if (!r || r.status !== from) return false;
      byState.set(state, { ...r, ...patch, status: to });
      return true;
    },
    async update(state, patch) {
      const r = byState.get(state);
      if (r) byState.set(state, { ...r, ...patch, status: r.status });
    },
  };
}
