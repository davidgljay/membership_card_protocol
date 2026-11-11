/**
 * Reference site for card login (implementation plan step 4.8). A framework-
 * free request handler using only the app-sdk login module — the
 * "add the button, issue a request, verify the response" integration a site
 * operator writes. Lines between the LOGIN-INTEGRATION markers are the
 * integration code counted for the strategic plan's "under ~50 lines" goal.
 */
import {
  createLoginRequest,
  serveLoginRequest,
  handleFormPost,
  createInMemoryLoginStore,
  stateCookie,
  readStateCookie,
  routerLoginUrl,
  type ServerCardIdentity,
  type SecureKeyProvider,
} from '@membership-card-protocol/app-sdk';
import type { CardVerifier } from '@membership-card-protocol/verifier';

export interface SiteRequest { method: string; url: string; headers: Record<string, string>; body?: string }
export interface SiteResponse { status: number; headers: Record<string, string>; body: string }

export function createReferenceSite(config: {
  origin: string;
  routerOrigin: string;
  server: ServerCardIdentity;
  keyProvider: SecureKeyProvider;
  verifier: CardVerifier;
  policy: string;
}) {
  const sessions = new Map<string, string>();
  // ── LOGIN-INTEGRATION begin ──
  const store = createInMemoryLoginStore();
  async function handle(req: SiteRequest): Promise<SiteResponse> {
    const url = new URL(req.url);
    if (url.pathname === '/login/start') {
      const { requestId, state, request } = await createLoginRequest({
        server: config.server, keyProvider: config.keyProvider, store,
        policies: [{ id: config.policy, include_children: false }],
        responseMode: 'form_post', responseUri: `${config.origin}/login/cb`, purpose: 'Log in to the member forum',
      });
      const location = routerLoginUrl({ routerOrigin: config.routerOrigin, requestUri: `${config.origin}/login/r/${requestId}` });
      return { status: 302, headers: { location, 'set-cookie': stateCookie(state, request.expires_at, '/login') }, body: '' };
    }
    if (url.pathname.startsWith('/login/r/')) {
      const r = await serveLoginRequest(store, url.pathname.slice('/login/r/'.length));
      return r.status === 200
        ? { status: 200, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }, body: JSON.stringify(r.body) }
        : { status: 410, headers: {}, body: 'gone' };
    }
    if (url.pathname === '/login/cb' && req.method === 'POST') {
      const form = Object.fromEntries(new URLSearchParams(req.body ?? ''));
      const result = await handleFormPost({ body: form, cookieState: readStateCookie(req.headers['cookie']), store, verifier: config.verifier as never, expectedOrigin: config.origin });
      if (!result.ok) return { status: 400, headers: { 'content-type': 'text/plain' }, body: `Login failed: ${result.code}` };
      const sid = crypto.randomUUID();
      sessions.set(sid, result.presentedCard);
      return { status: 303, headers: { location: '/me', 'set-cookie': `sid=${sid}; Path=/; Secure; HttpOnly; SameSite=Lax` }, body: '' };
    }
  // ── LOGIN-INTEGRATION end ──
    if (url.pathname === '/me') {
      const sid = /(?:^|;\s*)sid=([^;]+)/.exec(req.headers['cookie'] ?? '')?.[1];
      const card = sid ? sessions.get(sid) : undefined;
      return { status: 200, headers: { 'content-type': 'text/html' }, body: card ? `<h1>Logged in as ${card}</h1>` : '<h1>Not logged in</h1>' };
    }
    return { status: 404, headers: {}, body: 'not found' };
  }
  return { handle };
}
