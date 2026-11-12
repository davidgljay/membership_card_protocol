// login_router.md §10 — browser acceptance tests (Chromium, Firefox, WebKit).
// Wallet handler pages and `next` targets live on https://*.test hosts, which
// these tests intercept, so nothing leaves the machine.
import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';

const tokens = JSON.parse(readFileSync('test/e2e/.fixtures/tokens.json', 'utf-8')) as Record<'a' | 'b' | 'rogue', string>;
const REQ = 'https://forum.example.org/login/r/abc';

async function interceptTestHosts(page: Page): Promise<string[]> {
  const external: string[] = [];
  await page.route(/^https:\/\/[^/]+\.test\//, (route) => {
    external.push(route.request().url());
    return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>stub</title>' });
  });
  return external;
}
const register = (page: Page, who: 'a' | 'b' | 'rogue', next = 'https://issuer.test/welcome') =>
  page.goto(`/register/#${new URLSearchParams({ token: tokens[who], next }).toString()}`);
const login = (page: Page, extra: Record<string, string> = {}) =>
  page.goto(`/login/#${new URLSearchParams({ request_uri: REQ, ...extra }).toString()}`);
const stored = (page: Page) => page.evaluate(() => JSON.parse(localStorage.getItem('mcard-router:v1') ?? 'null'));

test('§10: /register with a valid token stores it as default and forwards to next with no visible page', async ({ page }) => {
  await interceptTestHosts(page);
  await register(page, 'a');
  await page.waitForURL('https://issuer.test/welcome');
  await page.goto('/settings/');
  expect(await stored(page)).toMatchObject({ default: 'card-a', wallets: [{ app_card: 'card-a' }] });
});

test('§10: a second wallet is added without changing the default', async ({ page }) => {
  await interceptTestHosts(page);
  await register(page, 'a');
  await page.waitForURL('https://issuer.test/welcome');
  await register(page, 'b');
  await page.waitForURL('https://issuer.test/welcome');
  await page.goto('/settings/');
  const s = await stored(page);
  expect(s.default).toBe('card-a');
  expect(s.wallets.map((w: { app_card: string }) => w.app_card)).toEqual(['card-a', 'card-b']);
});

test('§10: a token from a non-certified wallet stores nothing', async ({ page }) => {
  await interceptTestHosts(page);
  await register(page, 'rogue');
  await page.waitForURL('https://issuer.test/welcome');
  await page.goto('/settings/');
  expect(await stored(page)).toBeNull();
});

test('§10: /login with one wallet forwards to handler_url#request_uri=… with no user action', async ({ page }) => {
  await interceptTestHosts(page);
  await register(page, 'a');
  await page.waitForURL('https://issuer.test/welcome');
  await login(page);
  await page.waitForURL(/^https:\/\/wallet-a\.test\/login#/);
  expect(new URLSearchParams(new URL(page.url()).hash.slice(1)).get('request_uri')).toBe(REQ);
});

test('§10: two wallets show the picker (default first); wallet_hint bypasses it', async ({ page }) => {
  await interceptTestHosts(page);
  await register(page, 'a');
  await page.waitForURL('https://issuer.test/welcome');
  await register(page, 'b');
  await page.waitForURL('https://issuer.test/welcome');
  await login(page);
  await expect(page.getByRole('heading', { name: 'Choose your wallet' })).toBeVisible();
  await expect(page.locator('button.wallet').first()).toHaveText('Wallet A');
  await login(page, { wallet_hint: 'card-b' });
  await page.waitForURL(/^https:\/\/wallet-b\.test\/login#/);
});

test('§10: no wallet → recovery; "Use my phone" only with fallback_uri; picking a wallet forwards', async ({ page }) => {
  await interceptTestHosts(page);
  await login(page);
  await expect(page.getByRole('heading', { name: 'Pick your wallet' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Use my phone' })).toHaveCount(0);
  await login(page, { fallback_uri: 'https://forum.test/qr' });
  await expect(page.getByRole('button', { name: 'Use my phone' })).toBeVisible();
  await page.getByRole('button', { name: 'Wallet B' }).click();
  await page.waitForURL(/^https:\/\/wallet-b\.test\/login#/);
});

test('§10: the fragment is removed from the address bar after /register', async ({ page }) => {
  await page.goto(`/register/#${new URLSearchParams({ token: tokens.a }).toString()}`);
  await expect(page.getByRole('heading', { name: 'Your wallet is set up for logging in' })).toBeVisible();
  expect(new URL(page.url()).hash).toBe('');
});

test('§10: /login and /register make no network requests beyond the router’s own files', async ({ page }) => {
  await interceptTestHosts(page); // the forward to the wallet is intercepted, not fetched
  const requests: string[] = [];
  page.on('request', (r) => requests.push(r.url()));
  await page.goto(`/register/#${new URLSearchParams({ token: tokens.a }).toString()}`);
  await expect(page.getByRole('heading', { name: 'Your wallet is set up for logging in' })).toBeVisible();
  await login(page, { wallet_hint: 'nobody' }); // one wallet → forwards to wallet-a
  await page.waitForURL(/^https:\/\/wallet-a\.test\/login#/);
  const own = requests.filter((u) => u.startsWith('http://localhost:8911/'));
  const other = requests.filter((u) => !u.startsWith('http://localhost:8911/') && !u.startsWith('https://wallet-a.test/'));
  expect(own.length).toBeGreaterThan(0);
  expect(other).toEqual([]);
});

test('§10: the default can be changed on /settings', async ({ page }) => {
  await interceptTestHosts(page);
  await register(page, 'a');
  await page.waitForURL('https://issuer.test/welcome');
  await register(page, 'b');
  await page.waitForURL('https://issuer.test/welcome');
  await page.goto('/settings/');
  await page.locator('li[data-app-card="card-b"]').getByRole('button', { name: 'Make default' }).click();
  expect((await stored(page)).default).toBe('card-b');
});
