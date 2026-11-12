/**
 * Browser glue for the login router's pages (login_router.md §3, §4, §6, §8).
 * Reads the URL fragment, clears it from history, applies src/core.ts, and
 * renders. Makes no network request except the §6 address lookup.
 */
import {
  STORAGE_KEY,
  parseStorage,
  withoutDelisted,
  parseLoginFragment,
  decideLogin,
  walletUrl,
  parseRegisterFragment,
  validateToken,
  registerWallet,
  setDefault,
  removeWallet,
  walletsForPlatform,
  addressLookupUrl,
  type CertifiedWallet,
  type RouterStorage,
  type StoredWallet,
  type WalletRegistrationToken,
} from './core.js';
import certifiedWallets from '../wallets.json';

const CERTIFIED = certifiedWallets as CertifiedWallet[];

function loadStorage(): RouterStorage {
  try {
    return withoutDelisted(parseStorage(localStorage.getItem(STORAGE_KEY)), CERTIFIED);
  } catch {
    return parseStorage(null); // storage blocked: behave as if empty (§7)
  }
}
function saveStorage(s: RouterStorage): boolean {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
    return true;
  } catch {
    return false;
  }
}

/** Reads the fragment once and removes it from the address bar and history. */
function takeFragment(): string {
  const hash = location.hash;
  if (hash) history.replaceState(null, '', location.pathname + location.search);
  return hash;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, ...children: (Node | string)[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  for (const c of children) e.append(c);
  return e;
}

function render(...nodes: Node[]): void {
  const main = document.querySelector('main')!;
  main.replaceChildren(...nodes);
}

function walletButton(w: { name: string; icon?: string }, onClick: () => void, primary = false): HTMLButtonElement {
  const b = el('button', { type: 'button', class: primary ? 'wallet primary' : 'wallet' });
  if (w.icon) b.append(el('img', { src: w.icon, alt: '', width: '32', height: '32' }));
  b.append(el('span', {}, w.name));
  b.addEventListener('click', onClick);
  return b;
}

function platform(): 'web' | 'ios' | 'android' {
  const ua = navigator.userAgent;
  if (/iPhone|iPad|iPod/.test(ua)) return 'ios';
  if (/Android/.test(ua)) return 'android';
  return 'web';
}

// ─── /login ─────────────────────────────────────────────────────────────────

function loginPage(): void {
  const params = parseLoginFragment(takeFragment());
  if ('error' in params) {
    render(el('h1', {}, 'This login link is broken'), el('p', {}, 'Go back to the site and try again.'));
    return;
  }
  const storage = loadStorage();
  const decision = decideLogin(params, storage);
  if (decision.kind === 'forward') {
    location.replace(decision.url);
    return;
  }
  if (decision.kind === 'picker') {
    render(
      el('h1', {}, 'Choose your wallet'),
      ...decision.wallets.map((w, i) => walletButton(w, () => location.replace(walletUrl(w, params.requestUri)), i === 0)),
      recoveryLink(params.requestUri, params.fallbackUri)
    );
    return;
  }
  recoveryPage(params.requestUri, params.fallbackUri);
}

function recoveryLink(requestUri: string, fallbackUri?: string): HTMLElement {
  const a = el('button', { type: 'button', class: 'link' }, 'My wallet isn’t here');
  a.addEventListener('click', () => recoveryPage(requestUri, fallbackUri));
  return a;
}

/** §6 — never a dead end. */
function recoveryPage(requestUri: string, fallbackUri?: string): void {
  const nodes: Node[] = [el('h1', {}, 'Log in with your membership card'), el('h2', {}, 'Pick your wallet')];
  for (const w of walletsForPlatform(CERTIFIED, platform())) {
    nodes.push(walletButton(w, () => location.replace(walletUrl(w, requestUri))));
  }
  if (fallbackUri) {
    const phone = el('button', { type: 'button', class: 'wallet' }, 'Use my phone');
    phone.addEventListener('click', () => location.assign(fallbackUri));
    nodes.push(el('h2', {}, 'Use a wallet on another device'), phone);
  }
  const input = el('input', { type: 'text', id: 'wallet-address', placeholder: 'mywallet.example', autocomplete: 'off' });
  const go = el('button', { type: 'button' }, 'Find my wallet');
  const status = el('p', { role: 'status' });
  go.addEventListener('click', async () => {
    const url = addressLookupUrl(input.value);
    if (!url) {
      status.textContent = 'That doesn’t look like a web address.';
      return;
    }
    try {
      const res = await fetch(url, { credentials: 'omit', referrerPolicy: 'no-referrer' });
      const token = (await res.json()) as WalletRegistrationToken;
      const check = validateToken(token, CERTIFIED, location.origin, new Date());
      if (!check.ok) throw new Error(check.reason);
      const next = registerWallet(loadStorage(), check.token, new Date());
      saveStorage(next);
      location.replace(walletUrl(check.token, requestUri));
    } catch (e) {
      status.textContent = `Couldn’t use that wallet: ${(e as Error).message}`;
    }
  });
  nodes.push(el('h2', {}, 'Find my wallet by address'), el('label', { for: 'wallet-address' }, 'Your wallet’s web address'), input, go, status);
  render(...nodes);
}

// ─── /register ──────────────────────────────────────────────────────────────

function registerPage(): void {
  const params = parseRegisterFragment(takeFragment());
  const check = validateToken(params.token, CERTIFIED, location.origin, new Date());
  if (check.ok) saveStorage(registerWallet(loadStorage(), check.token, new Date()));
  // Registration failure must never strand the user mid-onboarding (§4 step 1).
  if (params.next) {
    location.replace(params.next);
    return;
  }
  if (!check.ok) {
    render(el('h1', {}, 'This wallet couldn’t be set up for logging in'), el('p', {}, check.reason));
    return;
  }
  const done = el('button', { type: 'button', class: 'primary' }, 'Done');
  done.addEventListener('click', () => window.close());
  render(el('h1', {}, 'Your wallet is set up for logging in'), el('p', {}, `${check.token.name} will open when a site asks you to log in with a membership card.`), done);
}

// ─── /settings ──────────────────────────────────────────────────────────────

function settingsPage(): void {
  const draw = () => {
    const storage = loadStorage();
    const rows = storage.wallets.map((w: StoredWallet) => {
      const isDefault = w.app_card === storage.default;
      const makeDefault = el('button', { type: 'button' }, isDefault ? 'Default' : 'Make default');
      if (isDefault) makeDefault.setAttribute('disabled', '');
      makeDefault.addEventListener('click', () => {
        saveStorage(setDefault(loadStorage(), w.app_card));
        draw();
      });
      const remove = el('button', { type: 'button' }, 'Remove');
      remove.addEventListener('click', () => {
        saveStorage(removeWallet(loadStorage(), w.app_card));
        draw();
      });
      return el('li', { 'data-app-card': w.app_card }, el('span', {}, w.name), makeDefault, remove);
    });
    render(el('h1', {}, 'Your login wallets'), rows.length ? el('ul', {}, ...rows) : el('p', {}, 'No wallets are set up in this browser.'));
  };
  draw();
}

const page = document.body.dataset['page'];
function run(): void {
  if (page === 'login') loginPage();
  else if (page === 'register') registerPage();
  else if (page === 'settings') settingsPage();
}
run();
// A new request arriving while the router is already open in this tab is a
// same-document hash change, not a page load — handle it the same way.
window.addEventListener('hashchange', () => {
  if (location.hash && (page === 'login' || page === 'register')) run();
});
