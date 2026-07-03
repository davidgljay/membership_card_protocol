// In-house APNs client — decision #4 (resolved): "minimal HTTP/2 JWT-based
// APNs client ... no third-party push package." Implements APNs' provider
// token authentication scheme (RFC-ish: a short-lived ES256 JWT, cached and
// reused for up to ~55 minutes per Apple's guidance of "no more than once
// per hour"), sent as a bearer token on each HTTP/2 request to
// api.push.apple.com (or api.sandbox.push.apple.com).
//
// "HTTP/2" note: both the Cloudflare Workers runtime's `fetch()` and
// Node.js 18+'s `fetch()` (undici) negotiate HTTP/2 automatically via ALPN
// when the server supports it (APNs does, and requires it) — there is no
// separate "HTTP/2 client" API to opt into on either runtime the way there
// was with Node's older `http2` module. This client's own responsibility
// is producing the correct APNs-specific *headers* HTTP/2 carries
// (`apns-topic`, `apns-priority`, etc.) and the ES256 JWT, not
// hand-rolling frame-level HTTP/2 — that would be reimplementing what
// `fetch()` already does correctly on both target runtimes.

import { signJwtEs256 } from './jwt';

export interface ApnsCredentials {
  keyP8: string; // PEM contents of the .p8 key file
  keyId: string;
  teamId: string;
  bundleId: string;
  sandbox: boolean;
}

export interface ApnsSendResult {
  ok: boolean;
  status: number;
  apnsId?: string;
  reason?: string;
}

const TOKEN_TTL_MS = 55 * 60 * 1000; // Apple: refresh at most once per hour; refresh at 55m for margin.

interface CachedToken {
  token: string;
  issuedAtMs: number;
}

// Cache is keyed by keyId+teamId, module-scoped. Under Workers, a module
// scope is reused across requests within the same isolate (until the
// isolate is recycled), which is exactly the reuse APNs asks for — this is
// not relying on any Workers-specific persistence guarantee, just ordinary
// JS module state, the same as it would work under node-server.
const tokenCache = new Map<string, CachedToken>();

async function getProviderToken(creds: ApnsCredentials): Promise<string> {
  const cacheKey = `${creds.teamId}:${creds.keyId}`;
  const cached = tokenCache.get(cacheKey);
  if (cached && Date.now() - cached.issuedAtMs < TOKEN_TTL_MS) {
    return cached.token;
  }

  const issuedAtSeconds = Math.floor(Date.now() / 1000);
  const token = await signJwtEs256(creds.keyP8, {
    header: { alg: 'ES256', kid: creds.keyId },
    payload: { iss: creds.teamId, iat: issuedAtSeconds },
  });
  tokenCache.set(cacheKey, { token, issuedAtMs: Date.now() });
  return token;
}

// Custom data merged alongside `aps` in the push payload. relay.md §7.2
// step 7 uses `{ uuid }`; relay.md §9's re-registration push uses
// `{ type, relay_id }` — both are plain JSON-serializable records, so this
// client accepts either rather than being hard-typed to one shape.
export type ApnsPayload = Record<string, string>;

/**
 * Sends a silent (content-available) push. Custom `payload` fields are
 * merged into the APNs `aps` dict's sibling custom data alongside
 * `content-available: 1` so it triggers a background wake without a
 * visible banner (the relay never has message content to show — see
 * relay.md §1, the relay only buffers opaque encrypted blobs).
 */
export async function sendApnsPush(
  creds: ApnsCredentials,
  deviceToken: string,
  payload: ApnsPayload,
  fetchImpl: typeof fetch = fetch
): Promise<ApnsSendResult> {
  const token = await getProviderToken(creds);
  const host = creds.sandbox ? 'api.sandbox.push.apple.com' : 'api.push.apple.com';
  const url = `https://${host}/3/device/${deviceToken}`;

  const body = JSON.stringify({
    aps: { 'content-available': 1 },
    ...payload,
  });

  const res = await fetchImpl(url, {
    method: 'POST',
    headers: {
      authorization: `bearer ${token}`,
      'apns-topic': creds.bundleId,
      'apns-push-type': 'background',
      'apns-priority': '5', // required for content-available-only pushes
      'content-type': 'application/json',
    },
    body,
  });

  const apnsIdHeader = res.headers.get('apns-id');
  if (res.ok) {
    return { ok: true, status: res.status, ...(apnsIdHeader ? { apnsId: apnsIdHeader } : {}) };
  }

  let reason: string | undefined;
  try {
    const errBody = (await res.json()) as { reason?: string };
    reason = errBody.reason;
  } catch {
    // APNs error bodies are always JSON per Apple's docs; tolerate a
    // malformed/empty body rather than throwing from within error handling.
  }
  return {
    ok: false,
    status: res.status,
    ...(apnsIdHeader ? { apnsId: apnsIdHeader } : {}),
    ...(reason ? { reason } : {}),
  };
}

/** Test-only: clears the module-level provider-token cache between test cases. */
export function _resetApnsTokenCacheForTests(): void {
  tokenCache.clear();
}
