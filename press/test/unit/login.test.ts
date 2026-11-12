/**
 * Card login checks in the press (press.md §5.1 step 7, §5.3 steps 4a/5a,
 * §5.4 steps 5–6): P-15 (app-cert root), P-26, P-27, P-28, P-29.
 */
import { describe, it, expect, vi } from 'vitest';
import { ml_dsa44 } from '@noble/post-quantum/ml-dsa.js';
import { handleSubCardRegister } from '../../src/handlers/sub-card.js';
import { handleUpdate } from '../../src/handlers/update.js';
import { validateIssuanceRequest } from '../../src/functions/issuance.js';
import { preferredServicesProblem, assertDomainBindingIntent } from '../../src/functions/login.js';
import { createInMemoryKv } from '../../src/kv.js';
import { canonicalize } from '../../src/serialization.js';
import { toBase64url, keccak256 } from '../../src/functions/crypto.js';
import type { PressContext } from '../../src/context.js';
import type { SubCardRegistrationRequest, UpdateRequest, IssuanceRequest } from '../../src/types.js';

const kp = (b: number) => ml_dsa44.keygen(new Uint8Array(32).fill(b));
const addr = (pk: Uint8Array) => Buffer.from(keccak256(pk)).toString('hex');
const SERVICE = kp(0x61);
const OTHER = kp(0x62);
const SUB = kp(0x63);
const ADMIN = kp(0x64);
const APP_ROOT = 'a1'.repeat(32);
const LOGIN_ROOT = 'b2'.repeat(32);
const POLICY_CID = 'bafybeipolicy';
const PRESS_CID = 'bafybeipress';

function makeCtx(opts: { chain?: string[]; roots?: boolean; domainReg?: { admin: string; fraud_risk?: number; exists?: boolean } } = {}): PressContext {
  const chain = opts.chain ?? [];
  const roots = opts.roots ?? true;
  return {
    config: {
      PRESS_CARD_CID: PRESS_CID,
      PRESS_POLICY_CIDS: [POLICY_CID],
      STALENESS_WINDOW_SECONDS: 300,
      PRESS_APP_CERTIFICATION_ROOT: roots ? APP_ROOT : undefined,
      PRESS_LOGIN_SERVICE_CERTIFICATION_ROOT: roots ? LOGIN_ROOT : undefined,
    } as never,
    kv: createInMemoryKv(),
    verifier: {
      verifyCard: vi.fn().mockResolvedValue({ chain_reaches_trusted_root: true, is_currently_valid: true, chain_card_addresses: chain }),
    } as never,
    registry: {
      getCardEntry: vi.fn().mockResolvedValue({ exists: false, log_head_cid: new Uint8Array(0), policy_address: '0x' + '00'.repeat(32), last_press_address: '0x', forward_to: '0x' }),
      getSubCardEntry: vi.fn().mockRejectedValue(new Error('none')),
      getCardEventLog: vi.fn().mockResolvedValue([]),
      getDomainRegistration: vi.fn().mockResolvedValue({
        admin_card_address: '0x' + (opts.domainReg?.admin ?? addr(ADMIN.publicKey)),
        fraud_risk: opts.domainReg?.fraud_risk ?? 0,
        suspension_expires_at: 0n,
        exists: opts.domainReg?.exists ?? true,
      }),
      registerSubCard: vi.fn().mockResolvedValue('0xdeadbeef'),
    } as never,
    ipfs: {
      fetchFromIPFS: vi.fn().mockImplementation(async (cid: string) =>
        new TextEncoder().encode(JSON.stringify({ policy_id: POLICY_CID, field_definitions: {}, approved_presses: [PRESS_CID] }))
      ),
      pinToIPFS: vi.fn().mockResolvedValue('bafybeimock'),
    } as never,
    gas: { checkAppGasBalance: vi.fn().mockResolvedValue({ sufficient: true }), debitAppGasAccount: vi.fn() } as never,
    pressPublicKey: new Uint8Array(1312),
    pressAddress: '0x' + '00'.repeat(32),
  };
}

function subCardBody(holder: ReturnType<typeof kp>, app: ReturnType<typeof kp>, attestation: string): SubCardRegistrationRequest {
  const doc = {
    holder_primary_card: addr(holder.publicKey), holder_primary_card_pubkey: toBase64url(holder.publicKey),
    app_card: addr(app.publicKey), app_card_pubkey: toBase64url(app.publicKey),
    capabilities: ['auth_request'], recipient_pubkey: toBase64url(SUB.publicKey),
    issued_at: new Date().toISOString(), attestation_level: attestation,
  };
  const appSig = toBase64url(ml_dsa44.sign(canonicalize(doc as Record<string, unknown>), app.secretKey));
  const withApp = { ...doc, app_signature: appSig };
  const holderSig = toBase64url(ml_dsa44.sign(canonicalize(withApp as Record<string, unknown>), holder.secretKey));
  return { sub_card_document: withApp as never, holder_signature: holderSig };
}

const codeOf = async (p: Promise<unknown>) => (await p.then(() => null, (e) => e?.pressCode ?? String(e))) as string | null;

describe('press.md §5.4 — sub-card registration (login service rules)', () => {
  it('P-15: app card chain does not pass through PRESS_APP_CERTIFICATION_ROOT', async () => {
    expect(await codeOf(handleSubCardRegister(makeCtx({ chain: ['cc'.repeat(32)] }), subCardBody(OTHER, SERVICE, 'T2')))).toBe('P-15');
  });
  it('P-26: login service card as app_card for another master', async () => {
    expect(await codeOf(handleSubCardRegister(makeCtx({ chain: [LOGIN_ROOT, APP_ROOT] }), subCardBody(OTHER, SERVICE, 'T2')))).toBe('P-26');
  });
  it('P-27: S1 on a sub-card that is not a server card', async () => {
    expect(await codeOf(handleSubCardRegister(makeCtx({ chain: [APP_ROOT] }), subCardBody(OTHER, SERVICE, 'S1')))).toBe('P-27');
  });
  it('P-27: S1 server card when the press has no login service root configured', async () => {
    expect(await codeOf(handleSubCardRegister(makeCtx({ chain: [LOGIN_ROOT, APP_ROOT], roots: false }), subCardBody(SERVICE, SERVICE, 'S1')))).toBe('P-27');
  });
  it('a server card (login service card as app and holder, S1) passes the login checks', async () => {
    const code = await codeOf(handleSubCardRegister(makeCtx({ chain: [LOGIN_ROOT, APP_ROOT] }), subCardBody(SERVICE, SERVICE, 'S1')));
    expect(code === null || !['P-15', 'P-26', 'P-27'].includes(code)).toBe(true);
  });
});

describe('protocol-objects.md §2 — preferred_services shape (P-29)', () => {
  const ok = { origin: 'https://forum.example.org', name: 'Forum' };
  it.each([
    [[], null],
    [[ok], null],
    [[{ ...ok, icon: 'bafy', description: 'x' }], null],
  ])('valid: %j', (v, expected) => expect(preferredServicesProblem(v)).toBe(expected));
  it.each([
    ['not an array', 'x'],
    ['http origin', [{ ...ok, origin: 'http://forum.example.org' }]],
    ['path in origin', [{ ...ok, origin: 'https://forum.example.org/x' }]],
    ['non-default port', [{ ...ok, origin: 'https://forum.example.org:8443' }]],
    ['empty name', [{ ...ok, name: '' }]],
    ['duplicate origin', [ok, { ...ok, name: 'Again' }]],
    ['unknown field', [{ ...ok, url: 'x' }]],
  ])('invalid: %s', (_label, v) => expect(preferredServicesProblem(v)).not.toBeNull());

  it('handleUpdate rejects a malformed preferred_services update with P-29', async () => {
    const intent = {
      updater_card_address: addr(OTHER.publicKey), target_card_address: addr(OTHER.publicKey), code: 302,
      timestamp: new Date().toISOString(), field_updates: [{ field: 'preferred_services', value: [{ origin: 'http://x.org', name: 'X' }] }],
    };
    const sig = toBase64url(ml_dsa44.sign(canonicalize(intent as never), OTHER.secretKey));
    const body: UpdateRequest = { update_intent: intent, intent_signature: { public_key: toBase64url(OTHER.publicKey), signature: sig } };
    expect(await codeOf(handleUpdate(makeCtx(), body))).toBe('P-29');
  });

  it('validateIssuanceRequest rejects malformed preferred_services (P-29) and any domain_binding at issuance (P-28)', async () => {
    const ctx = makeCtx();
    const base = { policy_cid: POLICY_CID, requester_card_address: 'aa'.repeat(32) };
    const bad = { ...base, offer: { preferred_services: 'x' } } as unknown as IssuanceRequest;
    expect(await codeOf(validateIssuanceRequest(bad, ctx.config, ctx.kv, ctx.verifier, ctx.ipfs))).toBe('P-29');
    const binding = { ...base, offer: { domain_binding: {} } } as unknown as IssuanceRequest;
    expect(await codeOf(validateIssuanceRequest(binding, ctx.config, ctx.kv, ctx.verifier, ctx.ipfs))).toBe('P-28');
  });
});

describe('press.md §5.3 step 4a — code 520 domain_binding', () => {
  function binding(over: Record<string, unknown> = {}) {
    const unsigned = {
      admin_card: addr(ADMIN.publicKey), admin_card_pubkey: toBase64url(ADMIN.publicKey),
      domain: 'example.org', issued_at: '2026-11-01T00:00:00Z',
      login_service_card: addr(SERVICE.publicKey), login_service_card_pubkey: toBase64url(SERVICE.publicKey),
    };
    return { ...unsigned, admin_signature: toBase64url(ml_dsa44.sign(canonicalize(unsigned as never), ADMIN.secretKey)), ...over };
  }
  const target = addr(SERVICE.publicKey);
  const pk = toBase64url(SERVICE.publicKey);
  const updates = (b = binding()) => [{ field: 'domain_binding', value: b }];

  it('accepts a valid binding for a login service card', async () => {
    await expect(assertDomainBindingIntent(makeCtx({ chain: [target, LOGIN_ROOT, APP_ROOT] }), updates(), target, pk)).resolves.toBeUndefined();
  });
  it.each([
    ['target not under the login service branch', { chain: [target, APP_ROOT] }, updates()],
    ['press has no login service root', { chain: [target, LOGIN_ROOT], roots: false }, updates()],
    ['binding altered after signing', { chain: [target, LOGIN_ROOT] }, updates(binding({ domain: 'example.net' }))],
    ['admin card is not the domain admin', { chain: [target, LOGIN_ROOT], domainReg: { admin: 'cd'.repeat(32) } }, updates()],
    ['domain not registered', { chain: [target, LOGIN_ROOT], domainReg: { admin: addr(ADMIN.publicKey), exists: false } }, updates()],
    ['more than one field', { chain: [target, LOGIN_ROOT] }, [...updates(), { field: 'name', value: 'x' }]],
  ])('P-28: %s', async (_label, ctxOpts, fieldUpdates) => {
    expect(await codeOf(assertDomainBindingIntent(makeCtx(ctxOpts), fieldUpdates, target, pk))).toBe('P-28');
  });

  it('P-23: code 520 posted by anyone other than the card itself', async () => {
    const intent = {
      updater_card_address: addr(OTHER.publicKey), target_card_address: target, code: 520,
      timestamp: new Date().toISOString(), field_updates: updates(),
    };
    const sig = toBase64url(ml_dsa44.sign(canonicalize(intent as never), OTHER.secretKey));
    const body: UpdateRequest = { update_intent: intent as never, intent_signature: { public_key: toBase64url(OTHER.publicKey), signature: sig } };
    const ctx = makeCtx({ chain: [target, LOGIN_ROOT] });
    (ctx.registry as unknown as { getCardEntry: unknown }).getCardEntry = vi.fn().mockResolvedValue({ exists: true, log_head_cid: new Uint8Array(0), policy_address: '0x' + '00'.repeat(32), last_press_address: '0x', forward_to: '0x' });
    expect(await codeOf(handleUpdate(ctx, body))).toBe('P-23');
  });

  it('P-25: domain_binding set by any code other than 520', async () => {
    const intent = {
      updater_card_address: target, target_card_address: target, code: 300,
      timestamp: new Date().toISOString(), field_updates: updates(),
    };
    const sig = toBase64url(ml_dsa44.sign(canonicalize(intent as never), SERVICE.secretKey));
    const body: UpdateRequest = { update_intent: intent as never, intent_signature: { public_key: pk, signature: sig } };
    expect(await codeOf(handleUpdate(makeCtx(), body))).toBe('P-25');
  });
});
