/**
 * Error-code coverage tests (press.md §7).
 *
 * Every P-xx code must appear in at least one test's expected output.
 * This file covers the 13 codes not already tested in other unit test files.
 * (P-02, P-03, P-04, P-10, P-17, P-18, P-19, P-20, P-24 are in predicates/ipfs/gas tests.)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ml_dsa44 } from '@noble/post-quantum/ml-dsa.js';
import { handleIssue, handleIssueFinalize } from '../../src/handlers/issue.js';
import { handleOpenOfferClaim } from '../../src/handlers/open-offer.js';
import { handleUpdate } from '../../src/handlers/update.js';
import { handleSubCardRegister, handleSubCardDeregister } from '../../src/handlers/sub-card.js';
import { createInMemoryKv } from '../../src/kv.js';
import { toBase64url, keccak256, fromBase64url } from '../../src/functions/crypto.js';
import type { PressContext } from '../../src/context.js';
import type {
  IssuanceRequest, FinalizeRequest, OpenOfferClaimSubmission,
  UpdateRequest, SubCardRegistrationRequest, SubCardDeregistrationRequest,
} from '../../src/types.js';

// ---------------------------------------------------------------------------
// Shared keypairs
// ---------------------------------------------------------------------------

const pressSeed = new Uint8Array(32).fill(0x11);
const { secretKey: PRESS_SK, publicKey: PRESS_PK } = ml_dsa44.keygen(pressSeed);
const issuerSeed = new Uint8Array(32).fill(0x22);
const { secretKey: ISSUER_SK, publicKey: ISSUER_PK } = ml_dsa44.keygen(issuerSeed);
const holderSeed = new Uint8Array(32).fill(0x33);
const { secretKey: HOLDER_SK, publicKey: HOLDER_PK } = ml_dsa44.keygen(holderSeed);
const appSeed = new Uint8Array(32).fill(0x44);
const { secretKey: APP_SK, publicKey: APP_PK } = ml_dsa44.keygen(appSeed);

const PRESS_CID = 'bafybeipress';
const POLICY_CID = 'bafybeipolicy';
const ISSUER_ADDR = '0x' + Buffer.from(ISSUER_PK).slice(0, 32).toString('hex');
const APP_ADDR = '0x' + Buffer.from(APP_PK).slice(0, 32).toString('hex');
const HOLDER_ADDR = '0x' + Buffer.from(HOLDER_PK).slice(0, 32).toString('hex');

// ---------------------------------------------------------------------------
// Mock context factory
// ---------------------------------------------------------------------------

function makeCtx(overrides: Partial<PressContext> = {}): PressContext {
  const kv = createInMemoryKv();
  const mockIpfs = {
    fetchFromIPFS: vi.fn().mockImplementation(async (cid: string) => {
      if (cid === POLICY_CID) {
        return new TextEncoder().encode(JSON.stringify({
          policy_id: POLICY_CID,
          field_definitions: {},
          approved_presses: [PRESS_CID],
          valid_until: new Date(Date.now() + 86400_000).toISOString(),
          allow_open_offers: true,
        }));
      }
      return new Uint8Array(0);
    }),
    pinToIPFS: vi.fn().mockResolvedValue('bafybeimockcid'),
  };

  const passVerifier = {
    verifyCard: vi.fn().mockResolvedValue({
      chain_reaches_trusted_root: true,
      is_currently_valid: true,
      revocation: { status: 'not_revoked', code: null, effective_date: null, data_freshness_seconds: 0 },
    }),
  };

  const mockRegistry = {
    getCardEntry: vi.fn().mockResolvedValue({ exists: true, log_head_cid: new Uint8Array(0), policy_address: '0x' + '00'.repeat(32), last_press_address: '0x', forward_to: '0x' }),
    getPressAuthorization: vi.fn().mockResolvedValue({ active: true, next_sequence: 0n, press_public_key: new Uint8Array(64), mldsa44_key_hash: '0x', key_scheme: 0, authorized_at: 0n, revoked_at: 0n }),
    getNextSequence: vi.fn().mockResolvedValue(0n),
    getOpenOfferUseCount: vi.fn().mockResolvedValue(0n),
    registerCard: vi.fn().mockResolvedValue('0xdeadbeef'),
    updateCardHead: vi.fn().mockResolvedValue('0xdeadbeef'),
    claimOpenOffer: vi.fn().mockResolvedValue('0xdeadbeef'),
    registerSubCard: vi.fn().mockResolvedValue('0xdeadbeef'),
    deregisterSubCard: vi.fn().mockResolvedValue('0xdeadbeef'),
    getPressEthBalance: vi.fn().mockResolvedValue(10n ** 18n),
    estimateGas: vi.fn().mockResolvedValue(200_000n),
  };

  const mockGas = {
    checkGasBalance: vi.fn().mockResolvedValue(undefined),
    checkAppGasBalance: vi.fn().mockResolvedValue({ sufficient: true }),
    creditAppGasAccount: vi.fn(),
    debitAppGasAccount: vi.fn(),
    pollEthTransfers: vi.fn(),
  };

  return {
    config: {
      PRESS_CARD_CID: PRESS_CID,
      PRESS_MLDSA44_PRIVATE_KEY: PRESS_SK,
      PRESS_POLICY_CIDS: [POLICY_CID],
      PRESS_SECP256R1_PRIVATE_KEY: 'ab'.repeat(32),
      STALENESS_WINDOW_SECONDS: 300,
      MAX_BATCH_SIZE: 100,
    } as never,
    kv,
    verifier: passVerifier as never,
    registry: mockRegistry as never,
    ipfs: mockIpfs as never,
    gas: mockGas as never,
    pressPublicKey: PRESS_PK,
    pressAddress: '0x' + Buffer.from(PRESS_PK).slice(0, 32).toString('hex'),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

import { canonicalize, canonicalizeExcluding } from '../../src/serialization.js';

// `issuer_signature` is a bare base64url string (`protocol-objects.md §1`) —
// no embedded public key. Targeted offers (`IssuerOffer`) are verified
// against `ancestry_pubkeys[0]`; open offers (`OpenCardOffer`) against a
// separate explicit `issuer_pubkey` field — see press/src/types.ts.
function signOffer(offer: Record<string, unknown>) {
  const toSign = canonicalizeExcluding(offer, ['issuer_signature']);
  const sig = ml_dsa44.sign(toSign, ISSUER_SK);
  return { ...offer, issuer_signature: toBase64url(sig) };
}

// `issuer_card` must equal keccak256(ancestry_pubkeys[0]) for the targeted
// (`IssuerOffer`) binding check in `verifyIssuerSignature`. Unprefixed,
// matching wallet-sdk's convention for this same comparison.
const ISSUER_CARD_FOR_TARGETED = Buffer.from(keccak256(ISSUER_PK)).toString('hex');

function makeValidOffer() {
  const base = {
    policy_id: POLICY_CID,
    issuer_card: ISSUER_CARD_FOR_TARGETED,
    press_card: PRESS_CID,
    issued_at: new Date().toISOString(),
    ancestry_pubkeys: [toBase64url(ISSUER_PK)],
  };
  return signOffer(base) as IssuanceRequest['offer'];
}

// ---------------------------------------------------------------------------
// P-01: Missing fields / press not in approved_presses
// ---------------------------------------------------------------------------

describe('P-01', () => {
  it('throws P-01 when policy_cid is missing', async () => {
    const ctx = makeCtx();
    await expect(handleIssue(ctx, {} as IssuanceRequest)).rejects.toMatchObject({ pressCode: 'P-01' });
  });

  it('throws P-01 when press is not in approved_presses', async () => {
    const ctx = makeCtx({
      ipfs: {
        fetchFromIPFS: vi.fn().mockResolvedValue(new TextEncoder().encode(JSON.stringify({
          policy_id: POLICY_CID, field_definitions: {},
          approved_presses: ['bafybeidifferentpress'], // this press not listed
        }))),
        pinToIPFS: vi.fn(),
      } as never,
    });
    const req: IssuanceRequest = {
      policy_cid: POLICY_CID,
      requester_card_address: ISSUER_ADDR,
      offer: makeValidOffer(),
    };
    await expect(handleIssue(ctx, req)).rejects.toMatchObject({ pressCode: 'P-01' });
  });
});

// ---------------------------------------------------------------------------
// P-05: Invalid issuer signature
// ---------------------------------------------------------------------------

describe('P-05', () => {
  it('throws P-05 when issuer_signature is invalid on /issue', async () => {
    const ctx = makeCtx();
    const badOffer = { ...makeValidOffer() };
    badOffer.issuer_signature = toBase64url(new Uint8Array(2420).fill(0xff));
    const req: IssuanceRequest = {
      policy_cid: POLICY_CID,
      requester_card_address: ISSUER_ADDR,
      offer: badOffer,
    };
    await expect(handleIssue(ctx, req)).rejects.toMatchObject({ pressCode: 'P-05' });
  });

  it('throws P-05 when issuer binding check fails on open offer claim', async () => {
    const ctx = makeCtx();
    // issuer_pubkey present but doesn't match issuer_card (wrong — not keccak256(ISSUER_PK)).
    const base = {
      policy_id: POLICY_CID, issuer_card: '0x' + 'ab'.repeat(32), press_card: PRESS_CID,
      issued_at: new Date().toISOString(), issuer_pubkey: toBase64url(ISSUER_PK),
    };
    const offer = signOffer(base) as Record<string, unknown>;
    const claimPayload = { offer, recipient_pubkey: toBase64url(HOLDER_PK) };
    const toSignClaim = canonicalize(claimPayload as Record<string, unknown>);
    const recipSig = ml_dsa44.sign(toSignClaim, HOLDER_SK);
    const body: OpenOfferClaimSubmission = {
      claim_payload: claimPayload as never,
      recipient_signature: toBase64url(recipSig),
    };
    await expect(handleOpenOfferClaim(ctx, body)).rejects.toMatchObject({ pressCode: 'P-05' });
  });
});

// ---------------------------------------------------------------------------
// P-06: Invalid recipient signature on open offer claim
// ---------------------------------------------------------------------------

describe('P-06', () => {
  it('throws P-06 when recipient_signature is invalid', async () => {
    // issuer_card must equal keccak256(ISSUER_PK) so the binding check passes.
    const issuerCardAddr = Buffer.from(keccak256(ISSUER_PK)).toString('hex');
    const base = {
      policy_id: POLICY_CID, issuer_card: issuerCardAddr, press_card: PRESS_CID,
      issued_at: new Date().toISOString(), issuer_pubkey: toBase64url(ISSUER_PK),
    };
    const offer = signOffer(base) as Record<string, unknown>;
    // Issuer sig is valid; recipient sig is invalid.
    const claimPayload = { offer, recipient_pubkey: toBase64url(HOLDER_PK) };
    const body: OpenOfferClaimSubmission = {
      claim_payload: claimPayload as never,
      recipient_signature: toBase64url(new Uint8Array(2420)),
    };
    const ctx = makeCtx();
    await expect(handleOpenOfferClaim(ctx, body)).rejects.toMatchObject({ pressCode: 'P-06' });
  });
});

// ---------------------------------------------------------------------------
// P-07: Open offer expired
// ---------------------------------------------------------------------------

describe('P-07', () => {
  it('throws P-07 when open offer expires_at is in the past', async () => {
    const ctx = makeCtx();
    const issuerCardAddr = Buffer.from(keccak256(ISSUER_PK)).toString('hex');
    const base = {
      policy_id: POLICY_CID, issuer_card: issuerCardAddr, press_card: PRESS_CID,
      issued_at: new Date().toISOString(), expires_at: new Date(Date.now() - 10_000).toISOString(),
      issuer_pubkey: toBase64url(ISSUER_PK),
    };
    const offer = signOffer(base) as Record<string, unknown>;
    const claimPayload = { offer, recipient_pubkey: toBase64url(HOLDER_PK) };
    const toSignClaim = canonicalize(claimPayload as Record<string, unknown>);
    const recipSig = ml_dsa44.sign(toSignClaim, HOLDER_SK);
    const body: OpenOfferClaimSubmission = {
      claim_payload: claimPayload as never,
      recipient_signature: toBase64url(recipSig),
    };
    await expect(handleOpenOfferClaim(ctx, body)).rejects.toMatchObject({ pressCode: 'P-07' });
  });
});

// ---------------------------------------------------------------------------
// P-08: Open offer at capacity
// ---------------------------------------------------------------------------

describe('P-08', () => {
  it('throws P-08 when use_count >= max_acceptances', async () => {
    const issuerCardAddr = Buffer.from(keccak256(ISSUER_PK)).toString('hex');
    const ctx = makeCtx({
      registry: {
        ...makeCtx().registry,
        getOpenOfferUseCount: vi.fn().mockResolvedValue(5n), // at capacity
      } as never,
    });
    const base = {
      policy_id: POLICY_CID, issuer_card: issuerCardAddr, press_card: PRESS_CID,
      issued_at: new Date().toISOString(), max_acceptances: 5, issuer_pubkey: toBase64url(ISSUER_PK),
    };
    const offer = signOffer(base) as Record<string, unknown>;
    const claimPayload = { offer, recipient_pubkey: toBase64url(HOLDER_PK) };
    const toSignClaim = canonicalize(claimPayload as Record<string, unknown>);
    const recipSig = ml_dsa44.sign(toSignClaim, HOLDER_SK);
    const body: OpenOfferClaimSubmission = {
      claim_payload: claimPayload as never,
      recipient_signature: toBase64url(recipSig),
    };
    await expect(handleOpenOfferClaim(ctx, body)).rejects.toMatchObject({ pressCode: 'P-08' });
  });
});

// ---------------------------------------------------------------------------
// P-09: Invalid intent signature on UpdateIntentPayload
// ---------------------------------------------------------------------------

describe('P-09', () => {
  it('throws P-09 when intent_signature is invalid', async () => {
    const ctx = makeCtx();
    const intent = {
      updater_card_address: ISSUER_ADDR,
      target_card_address: HOLDER_ADDR,
      code: 100,
      timestamp: new Date().toISOString(),
    };
    const body: UpdateRequest = {
      update_intent: intent,
      intent_signature: {
        public_key: toBase64url(ISSUER_PK),
        signature: toBase64url(new Uint8Array(2420).fill(0xba)),
      },
    };
    await expect(handleUpdate(ctx, body)).rejects.toMatchObject({ pressCode: 'P-09' });
  });
});

// ---------------------------------------------------------------------------
// P-11: update_policy predicate not satisfied
// ---------------------------------------------------------------------------

describe('P-11', () => {
  it('throws P-11 when updater chain does not satisfy the update_policy predicate', async () => {
    const ctx = makeCtx({
      verifier: {
        verifyCard: vi.fn().mockResolvedValue({
          chain_reaches_trusted_root: false, // predicate fails
          is_currently_valid: true,
          revocation: { status: 'not_revoked', code: null, effective_date: null, data_freshness_seconds: 0 },
        }),
      } as never,
    });
    const intent = {
      updater_card_address: ISSUER_ADDR,
      target_card_address: HOLDER_ADDR,
      code: 100, // field update — triggers predicate check
      timestamp: new Date().toISOString(),
      field_updates: { role: 'member' },
    };
    const toSign = canonicalize(intent as unknown as Record<string, unknown>);
    const sig = ml_dsa44.sign(toSign, ISSUER_SK);
    const body: UpdateRequest = {
      update_intent: intent,
      intent_signature: { public_key: toBase64url(ISSUER_PK), signature: toBase64url(sig) },
    };
    await expect(handleUpdate(ctx, body)).rejects.toMatchObject({ pressCode: 'P-11' });
  });
});

// ---------------------------------------------------------------------------
// P-12: STALE_PREV_CID retry failed → P-12
// ---------------------------------------------------------------------------

describe('P-12', () => {
  it('throws P-12 when updateCardHead retries exhausted', async () => {
    const ctx = makeCtx({
      registry: {
        ...makeCtx().registry,
        getCardEntry: vi.fn().mockResolvedValue({ exists: true, log_head_cid: new Uint8Array([1, 2, 3]), policy_address: '0x' + '00'.repeat(32), last_press_address: '0x', forward_to: '0x' }),
        updateCardHead: vi.fn().mockRejectedValue(
          Object.assign(new Error('STALE_PREV_CID'), { pressCode: 'P-12' })
        ),
      } as never,
    });
    // P-12 is surfaced by appendLogEntry → updateCardHead when retry fails.
    // The registry.updateCardHead mock throws P-12 directly.
    const intent = {
      updater_card_address: ISSUER_ADDR,
      target_card_address: HOLDER_ADDR,
      code: 100,
      timestamp: new Date().toISOString(),
    };
    const toSign = canonicalize(intent as unknown as Record<string, unknown>);
    const sig = ml_dsa44.sign(toSign, ISSUER_SK);
    const body: UpdateRequest = {
      update_intent: intent,
      intent_signature: { public_key: toBase64url(ISSUER_PK), signature: toBase64url(sig) },
    };
    await expect(handleUpdate(ctx, body)).rejects.toMatchObject({ pressCode: 'P-12' });
  });
});

// ---------------------------------------------------------------------------
// P-13: Pubkey binding check failed on sub-card registration
// ---------------------------------------------------------------------------

describe('P-13', () => {
  it('throws P-13 when app_card_pubkey does not hash to app_card address', async () => {
    const ctx = makeCtx();
    const body: SubCardRegistrationRequest = {
      sub_card_document: {
        holder_primary_card: HOLDER_ADDR,
        holder_primary_card_pubkey: toBase64url(HOLDER_PK),
        app_card: '0x' + 'ff'.repeat(32), // doesn't match keccak256(APP_PK)
        app_card_pubkey: toBase64url(APP_PK),
        capabilities: [],
        recipient_pubkey: toBase64url(APP_PK),
        issued_at: new Date().toISOString(),
        attestation_level: 'T2',
        app_signature: { public_key: toBase64url(APP_PK), signature: toBase64url(new Uint8Array(2420)) },
      },
      holder_signature: { public_key: toBase64url(HOLDER_PK), signature: toBase64url(new Uint8Array(2420)) },
    };
    // P-13: app_card binding check. App sig is checked first but will fail;
    // depending on order, may get P-13 on the binding check first.
    await expect(handleSubCardRegister(ctx, body)).rejects.toMatchObject({ pressCode: expect.stringMatching(/^P-1[3]$/) });
  });
});

// ---------------------------------------------------------------------------
// P-14: Invalid master card holder signature
// ---------------------------------------------------------------------------

describe('P-14', () => {
  it('throws P-14 when holder_signature is invalid on sub-card registration', async () => {
    const { keccak256, fromBase64url } = await import('../../src/functions/crypto.js');
    const holderCardAddr = Buffer.from(keccak256(fromBase64url(toBase64url(HOLDER_PK)))).toString('hex');
    const appCardAddr = Buffer.from(keccak256(fromBase64url(toBase64url(APP_PK)))).toString('hex');

    // Valid app_signature.
    const docForAppSig = {
      holder_primary_card: holderCardAddr,
      holder_primary_card_pubkey: toBase64url(HOLDER_PK),
      app_card: appCardAddr,
      app_card_pubkey: toBase64url(APP_PK),
      capabilities: [], recipient_pubkey: toBase64url(APP_PK),
      issued_at: new Date().toISOString(), attestation_level: 'T2',
    };
    const appSigBytes = canonicalize(docForAppSig as Record<string, unknown>);
    const appSig = ml_dsa44.sign(appSigBytes, APP_SK);

    const ctx = makeCtx();
    const body: SubCardRegistrationRequest = {
      sub_card_document: {
        ...docForAppSig,
        attestation_level: 'T2',
        app_signature: { public_key: toBase64url(APP_PK), signature: toBase64url(appSig) },
      },
      holder_signature: {
        public_key: toBase64url(HOLDER_PK),
        signature: toBase64url(new Uint8Array(2420).fill(0xcc)), // invalid
      },
    };
    await expect(handleSubCardRegister(ctx, body)).rejects.toMatchObject({ pressCode: 'P-14' });
  });
});

// ---------------------------------------------------------------------------
// P-15: App card chain does not reach governance app-certification policy root
// ---------------------------------------------------------------------------

describe('P-15', () => {
  it('throws P-15 when app cert chain is untrusted', async () => {
    const { keccak256, fromBase64url } = await import('../../src/functions/crypto.js');
    const holderCardAddr = Buffer.from(keccak256(fromBase64url(toBase64url(HOLDER_PK)))).toString('hex');
    const appCardAddr = Buffer.from(keccak256(fromBase64url(toBase64url(APP_PK)))).toString('hex');

    const docForAppSig = {
      holder_primary_card: holderCardAddr, holder_primary_card_pubkey: toBase64url(HOLDER_PK),
      app_card: appCardAddr, app_card_pubkey: toBase64url(APP_PK),
      capabilities: [], recipient_pubkey: toBase64url(APP_PK),
      issued_at: new Date().toISOString(), attestation_level: 'T2',
    };
    const appSigBytes = canonicalize(docForAppSig as Record<string, unknown>);
    const appSig = ml_dsa44.sign(appSigBytes, APP_SK);
    const docWithAppSig = { ...docForAppSig, app_signature: { public_key: toBase64url(APP_PK), signature: toBase64url(appSig) } };
    const holderSigBytes = canonicalize(docWithAppSig as Record<string, unknown>);
    const holderSig = ml_dsa44.sign(holderSigBytes, HOLDER_SK);

    const ctx = makeCtx({
      verifier: {
        verifyCard: vi.fn().mockResolvedValue({
          chain_reaches_trusted_root: false, // app cert chain untrusted → P-15
          is_currently_valid: true,
          revocation: { status: 'not_revoked', code: null, effective_date: null, data_freshness_seconds: 0 },
        }),
      } as never,
    });

    const body: SubCardRegistrationRequest = {
      sub_card_document: { ...docForAppSig, attestation_level: 'T2', app_signature: { public_key: toBase64url(APP_PK), signature: toBase64url(appSig) } },
      holder_signature: { public_key: toBase64url(HOLDER_PK), signature: toBase64url(holderSig) },
    };
    await expect(handleSubCardRegister(ctx, body)).rejects.toMatchObject({ pressCode: 'P-15' });
  });
});

// ---------------------------------------------------------------------------
// P-16: App gas balance insufficient for RegisterSubCard
// ---------------------------------------------------------------------------

describe('P-16', () => {
  it('throws P-16 when app gas account is insufficient', async () => {
    const { keccak256, fromBase64url } = await import('../../src/functions/crypto.js');
    const holderCardAddr = Buffer.from(keccak256(fromBase64url(toBase64url(HOLDER_PK)))).toString('hex');
    const appCardAddr = Buffer.from(keccak256(fromBase64url(toBase64url(APP_PK)))).toString('hex');

    const docForAppSig = {
      holder_primary_card: holderCardAddr, holder_primary_card_pubkey: toBase64url(HOLDER_PK),
      app_card: appCardAddr, app_card_pubkey: toBase64url(APP_PK),
      capabilities: [], recipient_pubkey: toBase64url(APP_PK),
      issued_at: new Date().toISOString(), attestation_level: 'T2',
    };
    const appSigBytes = canonicalize(docForAppSig as Record<string, unknown>);
    const appSig = ml_dsa44.sign(appSigBytes, APP_SK);
    const docWithAppSig = { ...docForAppSig, app_signature: { public_key: toBase64url(APP_PK), signature: toBase64url(appSig) } };
    const holderSigBytes = canonicalize(docWithAppSig as Record<string, unknown>);
    const holderSig = ml_dsa44.sign(holderSigBytes, HOLDER_SK);

    const ctx = makeCtx({
      gas: {
        ...makeCtx().gas,
        checkAppGasBalance: vi.fn().mockResolvedValue({ sufficient: false }),
      } as never,
    });

    const body: SubCardRegistrationRequest = {
      sub_card_document: { ...docForAppSig, attestation_level: 'T2', app_signature: { public_key: toBase64url(APP_PK), signature: toBase64url(appSig) } },
      holder_signature: { public_key: toBase64url(HOLDER_PK), signature: toBase64url(holderSig) },
    };
    await expect(handleSubCardRegister(ctx, body)).rejects.toMatchObject({ pressCode: 'P-16' });
  });
});

// ---------------------------------------------------------------------------
// P-21: Policy valid_until has passed
// ---------------------------------------------------------------------------

describe('P-21', () => {
  it('throws P-21 when policy has expired', async () => {
    const ctx = makeCtx({
      ipfs: {
        fetchFromIPFS: vi.fn().mockResolvedValue(new TextEncoder().encode(JSON.stringify({
          policy_id: POLICY_CID, field_definitions: {},
          approved_presses: [PRESS_CID],
          valid_until: new Date(Date.now() - 86400_000).toISOString(), // yesterday
        }))),
        pinToIPFS: vi.fn(),
      } as never,
    });
    const req: IssuanceRequest = {
      policy_cid: POLICY_CID,
      requester_card_address: ISSUER_ADDR,
      offer: makeValidOffer(),
    };
    await expect(handleIssue(ctx, req)).rejects.toMatchObject({ pressCode: 'P-21' });
  });
});

// ---------------------------------------------------------------------------
// P-22: Stale offer timestamp
// ---------------------------------------------------------------------------

describe('P-22', () => {
  it('throws P-22 when offer.issued_at is older than staleness window', async () => {
    // Sign the offer with the stale timestamp so the issuer sig remains valid.
    const staleBase = {
      policy_id: POLICY_CID, issuer_card: ISSUER_CARD_FOR_TARGETED, press_card: PRESS_CID,
      issued_at: new Date(Date.now() - 600_000).toISOString(), // 10 min ago > 5 min window
      ancestry_pubkeys: [toBase64url(ISSUER_PK)],
    };
    const staleOffer = signOffer(staleBase) as IssuanceRequest['offer'];
    const ctx = makeCtx();
    const req: IssuanceRequest = { policy_cid: POLICY_CID, requester_card_address: ISSUER_ADDR, offer: staleOffer };
    await expect(handleIssue(ctx, req)).rejects.toMatchObject({ pressCode: 'P-22' });
  });

  it('throws P-22 when update intent timestamp is stale', async () => {
    const ctx = makeCtx();
    const intent = {
      updater_card_address: ISSUER_ADDR,
      target_card_address: HOLDER_ADDR,
      code: 100,
      timestamp: new Date(Date.now() - 600_000).toISOString(), // 10 minutes ago (> 5 min window)
    };
    const toSign = canonicalize(intent as unknown as Record<string, unknown>);
    const sig = ml_dsa44.sign(toSign, ISSUER_SK);
    const body: UpdateRequest = {
      update_intent: intent,
      intent_signature: { public_key: toBase64url(ISSUER_PK), signature: toBase64url(sig) },
    };
    await expect(handleUpdate(ctx, body)).rejects.toMatchObject({ pressCode: 'P-22' });
  });
});
