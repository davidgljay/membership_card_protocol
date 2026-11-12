/** URL and cookie helpers for card login (app_sdk.md §9a.2, card_login.md Phase 1). */

export const DEFAULT_STATE_COOKIE = 'mcard_login_state';

/**
 * Set-Cookie value binding the browser to a pending login (card_login.md
 * step 4). SameSite=None is required: the form_post arrives as a cross-site
 * top-level POST from the wallet.
 */
export function stateCookie(state: string, expiresAt: string, path: string, name: string = DEFAULT_STATE_COOKIE): string {
  if (!/^[A-Za-z0-9_-]+$/.test(state)) throw new Error('stateCookie: state must be base64url');
  return `${name}=${state}; Path=${path}; Expires=${new Date(expiresAt).toUTCString()}; Secure; HttpOnly; SameSite=None`;
}

/** Clears the state cookie once a login completes. */
export function clearStateCookie(path: string, name: string = DEFAULT_STATE_COOKIE): string {
  return `${name}=; Path=${path}; Max-Age=0; Secure; HttpOnly; SameSite=None`;
}

/** Reads the state cookie from a Cookie request header. */
export function readStateCookie(cookieHeader: string | null | undefined, name: string = DEFAULT_STATE_COOKIE): string | undefined {
  for (const part of (cookieHeader ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=') || undefined;
  }
  return undefined;
}

/** login_router.md §3 — fragment-only parameters, never sent to the router host. */
export function routerLoginUrl(options: { routerOrigin: string; requestUri: string; walletHint?: string; fallbackUri?: string }): string {
  const params = new URLSearchParams({ request_uri: options.requestUri });
  if (options.walletHint) params.set('wallet_hint', options.walletHint);
  if (options.fallbackUri) params.set('fallback_uri', options.fallbackUri);
  return `${options.routerOrigin.replace(/\/$/, '')}/login#${params.toString()}`;
}

/** dns_resolution.md §2 reserved action host `auth` — for QR codes and deep links. */
export function crossDeviceLink(requestUri: string): string {
  return `mcard://auth?r=${encodeURIComponent(requestUri)}`;
}

/** card_login.md step 31 — reads the wallet-initiated parameters from the start URL. */
export function parseWalletStart(url: string): { walletNonce?: string; walletHint?: string } {
  const u = new URL(url);
  const walletNonce = u.searchParams.get('wallet_nonce') ?? undefined;
  const walletHint = u.searchParams.get('wallet_hint') ?? undefined;
  return {
    ...(walletNonce && /^[A-Za-z0-9_-]{16,}$/.test(walletNonce) ? { walletNonce } : {}),
    ...(walletHint ? { walletHint } : {}),
  };
}
