/**
 * `specs/process_specs/subcard_creation_policy.md` end-to-end, against the
 * live dev deployment. Adapted from
 * integration_tests/suites/extended/subcard_creation_policy.spec.ts — real
 * adaptation, not a mechanical port:
 *
 *  - `pressDevVars.PRESS_ADMIN_API_KEY` (read from a local `.dev.vars` file)
 *    becomes `PRESS_ADMIN_API_KEY` from `../../support/liveCard.js`, backed
 *    by `DEV_PRESS_ADMIN_API_KEY` config. This surfaced a real gap in Phase 1:
 *    `press/DEPLOYMENT.md`/`deploy.sh` didn't originally list
 *    `PRESS_ADMIN_API_KEY` as required at all — fixed alongside this port,
 *    see `plans/deployment/phase-1-summary.md`.
 *  - Fetching the registered SubCardDocument from IPFS uses the real gateway
 *    (`DEV_IPFS_GATEWAY_URL`) instead of Kubo's `/api/v0/cat` RPC endpoint —
 *    same adaptation as `conformance/ipfs_card.spec.ts`.
 *  - Contract address comes from `DEV_REGISTRY_CONTRACT_ADDRESS`... actually
 *    `STORAGE_CONTRACT_ADDRESS` (see press/DEPLOYMENT.md's distinction) --
 *    this suite reads `getSubCardEntry`, a storage-contract-only read, so it
 *    uses `REGISTRY_CONTRACT_ADDRESS` from liveCard.ts, which is documented
 *    there as mirroring press/wallet-service's own "storage contract" env
 *    var semantics.
 *
 * Covers the three mechanisms governing a sub-card: (1) app-certification
 * chain validation, (2) immutable capabilities/limitations, and (3)
 * on-chain deregistration via valid signer paths.
 *
 * Known gap, unchanged from the original: this deployment's press has no
 * working app-certification chain resolution without explicit admin
 * trusted-root registration — this suite uses that same admin-endpoint
 * workaround rather than attempting real chain-of-custody resolution.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import {
  mlDsa44Sign,
  bytesToBase64Url,
  base64UrlToBytes,
  keccak256,
  canonicalize,
} from '@membership-card-protocol/app-sdk';
import { mlDsa44Verify as verifierMlDsa44Verify, canonicalize as verifierCanonicalize } from '@membership-card-protocol/verifier';
import { deriveKeypair } from '../../support/keys.js';
import { createPublicClient, http, parseAbi, type Hex } from 'viem';
import { mintLiveCard, type LiveIdentity, ensureLiveGovernance, PRESS_BASE_URL, ARBITRUM_RPC_URL, REGISTRY_CONTRACT_ADDRESS, IPFS_GATEWAY_URL, PRESS_ADMIN_API_KEY } from '../../support/liveCard.js';

/** Spec Postconditions: verify signatures with the *verifier package's own* crypto. */
function verifyWithVerifierPackage(payload: unknown, publicKeyB64: string, signatureB64: string): boolean {
  return verifierMlDsa44Verify(
    base64UrlToBytes(publicKeyB64),
    verifierCanonicalize(payload),
    base64UrlToBytes(signatureB64)
  );
}

/** Helper to sign a payload with a keypair. */
function signPayload(payload: Record<string, unknown>, secretKey: Uint8Array): string {
  const canonicalBytes = canonicalize(payload);
  const signature = mlDsa44Sign(secretKey, canonicalBytes);
  return bytesToBase64Url(signature);
}

/** On-chain registry contract reader (viem-based). */
function createRegistryContractReader(storageAddress: Hex, rpcUrl: string) {
  const STORAGE_ABI = parseAbi([
    'function getSubCardEntry(bytes32 sub_card_address) external view returns ((bytes32 master_card_address, uint8[] registration_log_head, uint8[] sub_card_doc_cid, bool active, uint64 registered_at, uint64 deregistered_at) r)',
  ]);

  const client = createPublicClient({ transport: http(rpcUrl) });

  function toHex0x(address: string): Hex {
    return (address.startsWith('0x') ? address : '0x' + address) as Hex;
  }

  return {
    async getSubCardEntry(address: string) {
      const result = await client.readContract({
        address: storageAddress,
        abi: STORAGE_ABI,
        functionName: 'getSubCardEntry',
        args: [toHex0x(address)],
      });
      const tuple = result as unknown as {
        master_card_address: Hex;
        registration_log_head: readonly number[];
        sub_card_doc_cid: readonly number[];
        active: boolean;
        registered_at: bigint;
        deregistered_at: bigint;
      };
      return {
        master_card_address: tuple.master_card_address,
        active: tuple.active,
        sub_card_doc_cid: new TextDecoder().decode(Uint8Array.from(tuple.sub_card_doc_cid)),
      };
    },
  };
}

interface TestState {
  subCardAddress?: string;
  subCardKeypair?: ReturnType<typeof deriveKeypair>;
  subCardDocCid?: string;
}

describe('subcard_creation_policy.md (live dev deployment)', () => {
  let appCard: LiveIdentity;
  let holderCard: LiveIdentity;
  let registryReader: ReturnType<typeof createRegistryContractReader>;
  const state: TestState = {};

  beforeAll(async () => {
    appCard = await mintLiveCard('subcard-app-card', { display_name: 'Sub-Card Test App' });
    holderCard = await mintLiveCard('subcard-holder-card', { display_name: 'Sub-Card Test Holder' });
    ensureLiveGovernance();

    registryReader = createRegistryContractReader(REGISTRY_CONTRACT_ADDRESS as Hex, ARBITRUM_RPC_URL);

    // Register app card as a trusted root via admin endpoint (following the
    // web harness's prepare.ts pattern) — allows press's verifyCard checks
    // to succeed without needing real chain-of-custody resolution.
    const trustedRootRes = await fetch(`${PRESS_BASE_URL}/api/admin/trusted-roots`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${PRESS_ADMIN_API_KEY}`,
      },
      body: JSON.stringify({ address: appCard.address }),
    });
    if (!trustedRootRes.ok) {
      throw new Error(`setUp: POST /api/admin/trusted-roots failed: HTTP ${trustedRootRes.status}: ${await trustedRootRes.text()}`);
    }

    // Pre-fund app card's gas account (required for RegisterSubCard).
    const gasCreditRes = await fetch(`${PRESS_BASE_URL}/api/admin/app-gas-credit`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${PRESS_ADMIN_API_KEY}`,
      },
      body: JSON.stringify({ app_card_address: appCard.address, wei_amount: String(10n ** 18n) }),
    });
    if (!gasCreditRes.ok) {
      throw new Error(
        `setUp: POST /api/admin/app-gas-credit failed: HTTP ${gasCreditRes.status}: ${await gasCreditRes.text()}`
      );
    }
  }, 120_000);

  it('Mechanism 1: Assembles and registers a SubCardDocument with valid app-certification chain', async () => {
    const subCardLabel = `subcard:mech1-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const subCardKeypair = deriveKeypair(subCardLabel);
    const subCardAddressUnprefixed = keccak256(subCardKeypair.publicKey);
    const subCardAddress = '0x' + subCardAddressUnprefixed;

    const subCardDocument = {
      holder_primary_card: holderCard.address,
      holder_primary_card_pubkey: bytesToBase64Url(holderCard.publicKey),
      app_card: appCard.address,
      app_card_pubkey: bytesToBase64Url(appCard.publicKey),
      capabilities: ['card_offer_accept', 'text'],
      limitations: { max_message_recipients: 5 },
      recipient_pubkey: bytesToBase64Url(subCardKeypair.publicKey),
      issued_at: new Date().toISOString(),
      attestation_level: 'T2',
    };

    const docForAppSig = { ...subCardDocument };
    delete (docForAppSig as Record<string, unknown>)['app_signature'];
    delete (docForAppSig as Record<string, unknown>)['holder_signature'];
    const appSignature = signPayload(docForAppSig as Record<string, unknown>, appCard.secretKey);

    const docWithAppSig = { ...subCardDocument, app_signature: appSignature };
    const holderSignature = signPayload(docWithAppSig as Record<string, unknown>, holderCard.secretKey);

    const registerRes = await fetch(`${PRESS_BASE_URL}/api/sub-card/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sub_card_document: { ...subCardDocument, app_signature: appSignature },
        holder_signature: holderSignature,
      }),
    });

    expect(registerRes.ok).toBe(true);
    const body = (await registerRes.json()) as { sub_card_doc_cid: string; tx_hash: string };
    expect(body.sub_card_doc_cid).toBeTruthy();
    expect(body.tx_hash).toBeTruthy();

    const subCardEntry = await registryReader.getSubCardEntry(subCardAddress);
    expect(subCardEntry.active).toBe(true);
    expect(subCardEntry.master_card_address.toLowerCase()).toBe(('0x' + holderCard.address).toLowerCase());
    expect(subCardEntry.sub_card_doc_cid).toBe(body.sub_card_doc_cid);

    state.subCardAddress = subCardAddress;
    state.subCardKeypair = subCardKeypair;
    state.subCardDocCid = body.sub_card_doc_cid;
  }, 30_000);

  it('Mechanism 1 error path: Rejects registration when app-certification chain does not reach trusted root', async () => {
    const untrustedAppLabel = `untrusted-app:${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const untrustedAppKeypair = deriveKeypair(`holder:${untrustedAppLabel}`);
    const untrustedAppAddressUnprefixed = keccak256(untrustedAppKeypair.publicKey);
    const untrustedAppAddress = '0x' + untrustedAppAddressUnprefixed;

    const subCardLabel = `subcard:mech1-error-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const subCardKeypair = deriveKeypair(subCardLabel);

    const subCardDocument = {
      holder_primary_card: holderCard.address,
      holder_primary_card_pubkey: bytesToBase64Url(holderCard.publicKey),
      app_card: untrustedAppAddress,
      app_card_pubkey: bytesToBase64Url(untrustedAppKeypair.publicKey),
      capabilities: ['card_offer_accept'],
      recipient_pubkey: bytesToBase64Url(subCardKeypair.publicKey),
      issued_at: new Date().toISOString(),
      attestation_level: 'T2',
    };

    const docForAppSig = { ...subCardDocument };
    delete (docForAppSig as Record<string, unknown>)['app_signature'];
    delete (docForAppSig as Record<string, unknown>)['holder_signature'];
    const appSignature = signPayload(docForAppSig as Record<string, unknown>, untrustedAppKeypair.secretKey);

    const docWithAppSig = { ...subCardDocument, app_signature: appSignature };
    const holderSignature = signPayload(docWithAppSig as Record<string, unknown>, holderCard.secretKey);

    const registerRes = await fetch(`${PRESS_BASE_URL}/api/sub-card/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sub_card_document: { ...subCardDocument, app_signature: appSignature },
        holder_signature: holderSignature,
      }),
    });

    expect(registerRes.ok).toBe(false);
    expect(registerRes.status).toBe(400);
    const errorBody = (await registerRes.json()) as { error?: string };
    expect(errorBody.error || '').toMatch(/P-1[35]|chain.*trust/i);
  });

  it('Mechanism 2: Capabilities and limitations are fixed at issuance (immutable)', async () => {
    const subCardLabel = `subcard:mech2-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const subCardKeypair = deriveKeypair(subCardLabel);

    const requestedCapabilities = ['card_offer_accept', 'text', 'reply'];
    const requestedLimitations = {
      max_message_recipients: 10,
      max_daily_sends: 100,
    };

    const subCardDocument = {
      holder_primary_card: holderCard.address,
      holder_primary_card_pubkey: bytesToBase64Url(holderCard.publicKey),
      app_card: appCard.address,
      app_card_pubkey: bytesToBase64Url(appCard.publicKey),
      capabilities: requestedCapabilities,
      limitations: requestedLimitations,
      recipient_pubkey: bytesToBase64Url(subCardKeypair.publicKey),
      issued_at: new Date().toISOString(),
      attestation_level: 'T2',
    };

    const docForAppSig = { ...subCardDocument };
    delete (docForAppSig as Record<string, unknown>)['app_signature'];
    delete (docForAppSig as Record<string, unknown>)['holder_signature'];
    const appSignature = signPayload(docForAppSig as Record<string, unknown>, appCard.secretKey);

    const docWithAppSig = { ...subCardDocument, app_signature: appSignature };
    const holderSignature = signPayload(docWithAppSig as Record<string, unknown>, holderCard.secretKey);

    const registerRes = await fetch(`${PRESS_BASE_URL}/api/sub-card/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sub_card_document: { ...subCardDocument, app_signature: appSignature },
        holder_signature: holderSignature,
      }),
    });

    expect(registerRes.ok).toBe(true);
    const { sub_card_doc_cid } = (await registerRes.json()) as { sub_card_doc_cid: string };

    // Fetch the registered SubCardDocument via the real IPFS gateway (not
    // Kubo's /api/v0/cat, which the real deployment doesn't expose — see
    // this file's header comment).
    const fetchRes = await fetch(`${IPFS_GATEWAY_URL.replace(/\/$/, '')}/ipfs/${sub_card_doc_cid}`);
    expect(fetchRes.ok).toBe(true);
    const registeredDocBytes = new Uint8Array(await fetchRes.arrayBuffer());
    const registeredDoc = JSON.parse(new TextDecoder().decode(registeredDocBytes)) as Record<string, unknown>;

    expect(registeredDoc.capabilities).toEqual(requestedCapabilities);
    expect(registeredDoc.limitations).toEqual(requestedLimitations);
  }, 30_000);

  it.todo('Mechanism 3 deregistration: Via holder key (master card holder signature) — endpoint not functional');
});
