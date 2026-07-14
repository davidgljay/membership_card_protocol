/**
 * Matrix access-token minting for a card's shadow account
 * (matrix-implementation-plan.md Phase 4 Step 15c). Called by
 * POST /matrix/token after the caller's session token has been verified
 * and provisionShadowAccount (./provisioning.ts) has ensured the shadow
 * account exists.
 *
 * Mints via Synapse's Client-Server `POST /login` with
 * `type: "m.login.application_service"` and `identifier.user` set to the
 * shadow account's own Matrix user ID, authenticated as this
 * wallet-service's Application Service (Step 14's as_token) — the Matrix
 * AS login flow lets an AS mint a token for any user in its exclusive
 * namespace this way, without that user's own password (there isn't one).
 * The caller's own session-token check (done by the H3 route before
 * calling any of this — see server/routes/matrix/token.post.ts) is what
 * keeps a caller from minting a token for anyone but their own shadow
 * account; this module never takes an arbitrary matrix_user_id from
 * outside that trust boundary.
 *
 * Cached in the caller-supplied KvStore (server/utils/kv-store.ts's
 * convention; see kvKeys.matrixAccessToken in src/kv.ts) so repeated calls
 * within the cache TTL return the same token instead of re-minting one on
 * every call.
 */

import type { KvStore } from '../kv.js';
import { kvKeys } from '../kv.js';
import { readAppServiceAsToken } from './appservice-tokens.js';

/** Bounds how long a cached token is reused before a fresh one is minted. Matrix access tokens minted this way don't expire on their own; this is a cache-freshness bound, not a token TTL enforced by Synapse. */
const CACHE_TTL_SECONDS = 12 * 60 * 60;

export interface MintMatrixAccessTokenParams {
  matrixUserId: string;
  synapseBaseUrl: string;
  kv: KvStore;
  /** Defaults to reading matrix/secrets/appservice-as-token.txt; override for tests. */
  asToken?: string;
  /** Defaults to the global fetch; override for tests (same convention as src/relay-client.ts). */
  fetchImpl?: typeof fetch;
}

export interface MintMatrixAccessTokenResult {
  matrixAccessToken: string;
  matrixUserId: string;
}

interface SynapseLoginResponseBody {
  access_token?: string;
}

export async function mintMatrixAccessToken(
  params: MintMatrixAccessTokenParams
): Promise<MintMatrixAccessTokenResult> {
  const { matrixUserId, synapseBaseUrl, kv } = params;
  const asToken = params.asToken ?? readAppServiceAsToken();
  const fetchImpl = params.fetchImpl ?? fetch;

  const cacheKey = kvKeys.matrixAccessToken(matrixUserId);
  const cached = await kv.getItem<string>(cacheKey);
  if (cached) {
    return { matrixAccessToken: cached, matrixUserId };
  }

  const res = await fetchImpl(`${synapseBaseUrl}/_matrix/client/v3/login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${asToken}`,
    },
    body: JSON.stringify({
      type: 'm.login.application_service',
      identifier: { type: 'm.id.user', user: matrixUserId },
    }),
  });

  if (!res.ok) {
    throw new Error(`mintMatrixAccessToken: Synapse /login failed for ${matrixUserId} (status ${res.status}).`);
  }

  const body = (await res.json()) as SynapseLoginResponseBody;
  if (!body.access_token) {
    throw new Error(`mintMatrixAccessToken: Synapse /login response for ${matrixUserId} missing access_token.`);
  }

  await kv.setItem(cacheKey, body.access_token, CACHE_TTL_SECONDS);
  return { matrixAccessToken: body.access_token, matrixUserId };
}
