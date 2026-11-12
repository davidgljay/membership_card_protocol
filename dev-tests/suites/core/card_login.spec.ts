/**
 * process_specs/card_login.md against the dev environment (Arbitrum Sepolia,
 * dev press, Filebase) using the npm-published SDKs (implementation plan step
 * 5.1b).
 *
 * Skipped until both of these hold:
 *   1. The published SDKs include the login modules (card login is not yet
 *      published — checkpoint CP5).
 *   2. Someone with governance authority has provisioned the login fixtures on
 *      Sepolia (checkpoint CP4) and set the variables below:
 *        DEV_LOGIN_SERVICE_ROOT              login service branch node (bytes32 hex); also the
 *                                            dev press's PRESS_LOGIN_SERVICE_CERTIFICATION_ROOT
 *        DEV_LOGIN_APP_CERT_ROOT             app-certification root (bytes32 hex)
 *        DEV_LOGIN_SERVICE_CARD_PK / _SK     login service card keys (base64url), card already
 *                                            bound to DEV_LOGIN_DOMAIN with code 520 and funded for
 *                                            sub-card gas
 *        DEV_LOGIN_DOMAIN                    the bound, registered domain
 *        DEV_LOGIN_POLICY_ADDRESS            policy the member card was issued under
 *        DEV_LOGIN_USER_PK                   member card public key (base64url)
 *        DEV_LOGIN_DEVICE_PK / _SK           member card's registered device sub-card keys
 *                                            (capabilities include auth_response)
 *
 * The test creates a fresh server card through the dev press, then runs a
 * same-device login in-process (site = app-sdk, wallet = wallet-sdk) with
 * every check against Sepolia.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import * as appSdk from '@membership-card-protocol/app-sdk';
import * as walletSdk from '@membership-card-protocol/wallet-sdk';
import * as verifierPkg from '@membership-card-protocol/verifier';
import { PRESS_BASE_URL } from '../../support/liveCard.js';

const env = (k: string) => process.env[k] ?? '';
const REQUIRED = [
  'DEV_LOGIN_SERVICE_ROOT', 'DEV_LOGIN_APP_CERT_ROOT', 'DEV_LOGIN_SERVICE_CARD_PK', 'DEV_LOGIN_SERVICE_CARD_SK',
  'DEV_LOGIN_DOMAIN', 'DEV_LOGIN_POLICY_ADDRESS', 'DEV_LOGIN_USER_PK', 'DEV_LOGIN_DEVICE_PK', 'DEV_LOGIN_DEVICE_SK',
];
const sdkHasLogin = 'createLoginRequest' in appSdk && 'fetchAndValidateLoginRequest' in walletSdk && 'verifyLoginResponse' in (verifierPkg.CardVerifier.prototype as object);
const provisioned = REQUIRED.every((k) => env(k));

describe.skipIf(!sdkHasLogin || !provisioned)('card_login.md (dev environment)', () => {
  // Loaded lazily so the file still typechecks against SDK versions without login.
  const a = appSdk as unknown as Record<string, (...args: unknown[]) => unknown>;
  const ws = walletSdk as unknown as Record<string, (...args: unknown[]) => unknown>;
  const origin = `https://login.${env('DEV_LOGIN_DOMAIN')}`;
  // Typed loosely: the published verifier this suite installs may predate login.
  let verifier: verifierPkg.CardVerifier & { verifyServerCard: (pk: string, o: { origin: string }) => Promise<unknown> };
  let server: { pointer: string; pubkey: string; keyId: string };
  let keyProvider: unknown;

  beforeAll(async () => {
    const { createDevVerifier } = await import('../../support/devVerifier.js');
    verifier = (await createDevVerifier({
      appCertificationRoot: env('DEV_LOGIN_APP_CERT_ROOT'),
      loginServiceCertificationRoot: env('DEV_LOGIN_SERVICE_ROOT'),
    })) as typeof verifier;
    const testing = await import('@membership-card-protocol/app-sdk/testing' as string);
    keyProvider = (testing as { createDevSecureKeyProvider: () => unknown }).createDevSecureKeyProvider();
    const serviceSk = a['base64UrlToBytes']!(env('DEV_LOGIN_SERVICE_CARD_SK')) as Uint8Array;
    const servicePk = env('DEV_LOGIN_SERVICE_CARD_PK');
    const serviceAddr = a['keccak256']!(a['base64UrlToBytes']!(servicePk)) as string;
    const req = (await a['createServerCardRequest']!({ loginServiceCard: serviceAddr, loginServiceCardPubkey: servicePk, keyProvider, keyId: `dev-server-${Date.now()}` })) as {
      unsignedDocument: unknown; server: typeof server;
    };
    server = req.server;
    const transport = {
      async request(dest: { baseUrl: string }, o: { method: string; path: string; headers?: Record<string, string>; body?: Uint8Array }) {
        const res = await fetch(dest.baseUrl + o.path, { method: o.method, headers: o.headers, ...(o.body ? { body: o.body as unknown as ArrayBuffer } : {}) });
        const headers: Record<string, string> = {};
        res.headers.forEach((v, k) => (headers[k] = v));
        return { status: res.status, headers, body: new Uint8Array(await res.arrayBuffer()) };
      },
    };
    const authorized = (await ws['authorizeServerCard']!({
      unsignedDocument: req.unsignedDocument,
      loginServiceCardSecretKey: serviceSk,
      registerSubCard: a['createPressSubCardRegistrar']!({ transport, pressBaseUrl: PRESS_BASE_URL }),
      postActiveSubcardAddition: async (pk: string) => {
        const fields = await (verifierPkg as unknown as { readCardFields: (pk: string, c: unknown) => Promise<{ fields: Record<string, unknown> } | null> }).readCardFields(servicePk, (await import('../../support/devVerifier.js')).devChain());
        return ws['postSubCardAddedToDirectory']!({ transport, pressBaseUrl: PRESS_BASE_URL, masterCardPointer: serviceAddr, masterSecretKey: serviceSk, masterPublicKey: servicePk, currentActiveSubcards: (fields?.fields['active_subcards'] as string[]) ?? null, newSubCardPublicKey: pk });
      },
    })) as { registered: boolean; code?: string };
    if (!authorized.registered) throw new Error(`server card not registered: ${authorized.code}`);
  }, 900_000);

  it('verifyServerCard accepts the server card for the bound domain and rejects another domain', async () => {
    expect(await verifier.verifyServerCard(server.pubkey, { origin })).toMatchObject({ valid: true });
    expect(await verifier.verifyServerCard(server.pubkey, { origin: 'https://login.example.net' })).toMatchObject({ valid: false, code: 'LOGIN_ORIGIN_NOT_BOUND' });
  });

  it('same-device form_post login completes, bound to the member card', async () => {
    const store = a['createInMemoryLoginStore']!() as unknown;
    const issued = (await a['createLoginRequest']!({
      server, keyProvider, store, policies: [{ id: env('DEV_LOGIN_POLICY_ADDRESS'), include_children: false }],
      responseMode: 'form_post', responseUri: `${origin}/login/cb`, purpose: 'dev-tests login',
    })) as { requestId: string; state: string };
    const siteFetch = (async () => {
      const r = (await a['serveLoginRequest']!(store, issued.requestId)) as { status: number; body?: unknown };
      return new Response(JSON.stringify(r.body ?? null), { status: r.status });
    }) as typeof fetch;
    const { devChain } = await import('../../support/devVerifier.js');
    const validated = (await ws['fetchAndValidateLoginRequest']!({ handoff: { requestUri: `${origin}/login/r/${issued.requestId}`, via: 'router' }, verifier, fetch: siteFetch })) as { valid: boolean; request: unknown };
    expect(validated.valid).toBe(true);
    const matches = (await ws['matchLoginCredentials']!({ request: validated.request, heldCards: [{ pubkey: env('DEV_LOGIN_USER_PK') }], chain: devChain() })) as { card: string }[];
    expect(matches.length).toBe(1);
    const devicePk = a['base64UrlToBytes']!(env('DEV_LOGIN_DEVICE_PK')) as Uint8Array;
    const deviceSk = a['base64UrlToBytes']!(env('DEV_LOGIN_DEVICE_SK')) as Uint8Array;
    const built = (await ws['buildLoginResponse']!({ validated, presentedCard: matches[0]!.card, signer: { publicKey: devicePk, sign: (m: Uint8Array) => a['mlDsa44Sign']!(deviceSk, m) }, protocolVersion: '0.1' })) as { response: unknown };
    const post = ws['formPostFields']!(validated.request, built.response) as { fields: Record<string, string> };
    const r = await a['handleFormPost']!({ body: post.fields, cookieState: issued.state, store, verifier, expectedOrigin: origin });
    expect(r).toMatchObject({ ok: true, presentedCard: matches[0]!.card });
  }, 600_000);
});
