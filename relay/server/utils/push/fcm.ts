// In-house FCM HTTP v1 client — decision #4 (resolved): "minimal FCM HTTP
// v1 client ... no third-party push package." FCM HTTP v1 requires an
// OAuth2 access token obtained via a Google service-account JWT bearer
// grant (RFC 7523) — this client implements that token exchange plus the
// actual send call, nothing more (no topic messaging, no batch send, none
// of the FCM Admin SDK's broader surface this relay doesn't need).

import { signJwtRs256 } from './jwt';

export interface FcmServiceAccount {
  project_id: string;
  private_key: string;
  client_email: string;
}

export interface FcmSendResult {
  ok: boolean;
  status: number;
  messageName?: string;
  error?: string;
}

const ACCESS_TOKEN_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const ACCESS_TOKEN_TTL_MS = 55 * 60 * 1000; // Google tokens last 1h; refresh at 55m for margin.

interface CachedAccessToken {
  accessToken: string;
  issuedAtMs: number;
}

// Same module-scope caching rationale as apns.ts's tokenCache.
const accessTokenCache = new Map<string, CachedAccessToken>();

async function getAccessToken(
  account: FcmServiceAccount,
  fetchImpl: typeof fetch
): Promise<string> {
  const cacheKey = account.client_email;
  const cached = accessTokenCache.get(cacheKey);
  if (cached && Date.now() - cached.issuedAtMs < ACCESS_TOKEN_TTL_MS) {
    return cached.accessToken;
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  const assertion = await signJwtRs256(account.private_key, {
    header: { alg: 'RS256', typ: 'JWT' },
    payload: {
      iss: account.client_email,
      scope: ACCESS_TOKEN_SCOPE,
      aud: TOKEN_ENDPOINT,
      iat: nowSeconds,
      exp: nowSeconds + 3600,
    },
  });

  const res = await fetchImpl(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }).toString(),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`FCM token exchange failed: ${res.status} ${text}`);
  }

  const data = (await res.json()) as { access_token: string };
  accessTokenCache.set(cacheKey, { accessToken: data.access_token, issuedAtMs: Date.now() });
  return data.access_token;
}

// Same rationale as apns.ts's ApnsPayload: relay.md §7.2 step 7 uses
// `{ uuid }`, relay.md §9's re-registration push uses `{ type, relay_id }`
// — both plain string-keyed records, so this client isn't hard-typed to
// one shape.
export type FcmPayload = Record<string, string>;

/**
 * Sends a silent data-only push. Uses FCM's `data` field, not
 * `notification` — the relay has no message content to display (it only
 * buffers opaque encrypted blobs, relay.md §1), so this must never produce
 * a platform-rendered notification.
 */
export async function sendFcmPush(
  account: FcmServiceAccount,
  deviceToken: string,
  payload: FcmPayload,
  fetchImpl: typeof fetch = fetch
): Promise<FcmSendResult> {
  const accessToken = await getAccessToken(account, fetchImpl);
  const url = `https://fcm.googleapis.com/v1/projects/${account.project_id}/messages:send`;

  const res = await fetchImpl(url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${accessToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      message: {
        token: deviceToken,
        data: payload,
        android: { priority: 'high' },
      },
    }),
  });

  if (res.ok) {
    const data = (await res.json()) as { name?: string };
    return { ok: true, status: res.status, ...(data.name ? { messageName: data.name } : {}) };
  }

  let error: string | undefined;
  try {
    const errBody = (await res.json()) as { error?: { message?: string } };
    error = errBody.error?.message;
  } catch {
    // Tolerate a non-JSON error body.
  }
  return { ok: false, status: res.status, ...(error ? { error } : {}) };
}

/** Test-only: clears the module-level access-token cache between test cases. */
export function _resetFcmTokenCacheForTests(): void {
  accessTokenCache.clear();
}
