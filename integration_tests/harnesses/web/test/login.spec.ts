/**
 * Card login, same device, end to end (implementation plan step 4.8;
 * card_login.md Phases 1–6 with form_post). Real chain, press, and IPFS
 * (local stack); real login router build; reference site on app-sdk; web
 * wallet on wallet-sdk. The site, router, and wallet run on made-up https
 * hosts that Playwright serves, so the browser behaves as it would online
 * (Secure / SameSite=None cookies, cross-site form POST).
 */
import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { InMemorySecureKeyProvider } from '@membership-card-protocol/integration-fixtures';
import { signWalletRegistrationToken, routerRegistrationUrl } from '@membership-card-protocol/wallet-sdk';
import { buildLoginWorld, type LoginWorld } from '../../../suites/support/loginWorld.js';
import { createReferenceSite } from './login/referenceSite.js';
import { createWalletBackend, HANDLER_PAGE } from './login/webWallet.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROUTER_SRC = join(HERE, '../../../../login-router');
const ROUTER_OUT = join(HERE, '../test-results/login-router-dist');
const ROUTER = 'https://router.test';
const WALLET = 'https://wallet.test';

// This harness pins an older Playwright than the browsers installed for the
// login router; reuse an installed Chromium when the pinned one is missing.
const INSTALLED_CHROMIUM = join(process.env.HOME ?? '', 'Library/Caches/ms-playwright/chromium_headless_shell-1254/chrome-headless-shell-mac-arm64/chrome-headless-shell');
if (existsSync(INSTALLED_CHROMIUM)) test.use({ launchOptions: { executablePath: INSTALLED_CHROMIUM } });

let w: LoginWorld;
let routerDir: string;

test.beforeAll(async () => {
  test.setTimeout(900_000);
  w = await buildLoginWorld();
  // Build the router with this world's wallet card as the only certified wallet.
  mkdirSync(ROUTER_OUT, { recursive: true });
  const walletsFile = join(ROUTER_OUT, '..', 'login-router-wallets.json');
  writeFileSync(walletsFile, JSON.stringify([{ app_card: w.appRoot.address, app_card_pubkey: w.appRoot.pubkey, name: 'Harness Wallet', handler_url: `${WALLET}/login`, platforms: ['web'] }]));
  execFileSync('node', ['scripts/build.mjs'], { cwd: ROUTER_SRC, env: { ...process.env, ROUTER_OUTDIR: ROUTER_OUT, ROUTER_WALLETS: walletsFile }, stdio: 'inherit' });
  routerDir = ROUTER_OUT;
});

test('card_login: same-device form_post login through the router logs the user in as their card', async ({ page }) => {
  test.setTimeout(300_000);
  const origin = w.origin;
  const site = createReferenceSite({ origin, routerOrigin: ROUTER, server: w.server, keyProvider: w.server.keyProvider, verifier: w.verifier, policy: w.policyAddress });
  const fetchedRequestUris: string[] = [];
  const siteFetch = (async (input: string | URL | Request) => {
    fetchedRequestUris.push(String(input));
    const r = await site.handle({ method: 'GET', url: String(input), headers: {} });
    return new Response(r.body, { status: r.status, headers: r.headers });
  }) as typeof fetch;
  const wallet = createWalletBackend({
    verifier: w.verifier,
    chain: w.chain,
    heldCards: [{ pubkey: w.user.pubkey }],
    signer: { publicKey: w.device.publicKey, sign: w.device.sign },
    protocolVersion: '0.1',
    fetch: siteFetch,
  });

  // The site.
  await page.context().route(`${origin}/**`, async (route) => {
    const req = route.request();
    try {
      const r = await site.handle({ method: req.method(), url: req.url(), headers: await req.allHeaders(), body: req.postData() ?? undefined });
      if (r.status >= 301 && r.status <= 303 && r.headers['location']) {
        // Chromium does not follow redirects that a Playwright route fulfills for a
        // navigation; redirect by script instead (cookies still set from the header).
        const { location, ...rest } = r.headers;
        await route.fulfill({ status: 200, headers: { ...rest, 'content-type': 'text/html' }, body: `<!doctype html><script>location.replace(${JSON.stringify(new URL(location!, req.url()).toString())})</script>` });
      } else {
        await route.fulfill({ status: r.status, headers: r.headers, body: r.body });
      }
    } catch (e) {
      console.error('site handler error', e);
      await route.fulfill({ status: 500, body: String(e) });
    }
  });
  // The login router (static files from its build).
  await page.context().route(`${ROUTER}/**`, async (route) => {
    const path = new URL(route.request().url()).pathname;
    let file = join(routerDir, path);
    if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html');
    if (!existsSync(file)) return route.fulfill({ status: 404, body: 'not found' });
    const types: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
    await route.fulfill({ status: 200, headers: { 'content-type': types[extname(file)] ?? 'application/octet-stream' }, body: readFileSync(file) });
  });
  // The web wallet.
  await page.context().route(`${WALLET}/**`, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/login') return route.fulfill({ status: 200, headers: { 'content-type': 'text/html' }, body: HANDLER_PAGE });
    if (url.pathname === '/api/handle') {
      const out = await wallet(JSON.parse(route.request().postData() ?? '{}'));
      return route.fulfill({ status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify(out) });
    }
    return route.fulfill({ status: 404, body: 'not found' });
  });

  // 1. First-card acceptance registers the wallet with the router (silent, add-only).
  const keys = new InMemorySecureKeyProvider();
  await keys.generateKey('holder:login-app-root');
  const token = await signWalletRegistrationToken({
    token: { app_card: w.appRoot.address, app_card_pubkey: w.appRoot.pubkey, expires_at: new Date(Date.now() + 300 * 86400_000).toISOString(), handler_url: `${WALLET}/login`, issued_at: new Date().toISOString(), name: 'Harness Wallet', router_origin: ROUTER },
    appCardKeyId: 'holder:login-app-root',
    keyProvider: keys,
  });
  await page.goto(routerRegistrationUrl({ routerOrigin: ROUTER, token, next: `${origin}/me` }));
  await expect(page.locator('h1')).toHaveText('Not logged in');

  // 2. Log in: site → router → wallet → form_post → site session.
  await page.goto(`${origin}/login/start`);
  await expect(page.locator('h1')).toHaveText(`Logged in as ${w.user.address}`, { timeout: 120_000 });

  // 3. card_login §AC: the request URL is single-use — 410 once the login completed.
  expect(fetchedRequestUris).toHaveLength(1);
  expect((await site.handle({ method: 'GET', url: fetchedRequestUris[0]!, headers: {} })).status).toBe(410);
});

test('reference site: login integration is under ~50 lines', () => {
  const src = readFileSync(join(HERE, 'login/referenceSite.ts'), 'utf-8');
  const body = src.slice(src.indexOf('LOGIN-INTEGRATION begin'), src.indexOf('LOGIN-INTEGRATION end'));
  const lines = body.split('\n').slice(1).filter((l) => l.trim() && !l.trim().startsWith('//')).length;
  console.log(`reference site login integration: ${lines} lines`);
  expect(lines).toBeLessThanOrEqual(50);
});
