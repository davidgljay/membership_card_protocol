/**
 * Node-side setup, run before the browser page loads: mints a fresh
 * on-chain "root" card (reusing `integration_tests/fixtures`' `mintCard`
 * pattern — a real `registerCard` transaction under the same policy 2.1's
 * fixtures already registered and authorized the press for, so no new
 * governance calls are needed) and uses it to build and submit a real
 * targeted offer through the live press's `POST /issue`.
 *
 * The root card serves two roles for this scenario:
 * - `walletAppCard` identity for `setupWallet`'s device sub-card
 *   registration (`handleSubCardRequest` needs the app card's chain to
 *   reach a `CardVerifier`-configured trusted root).
 * - Offer issuer for the "accept a targeted offer" step
 *   (`reviewTargetedOffer` needs `issuer_card`'s chain to reach a trusted
 *   root the same way).
 *
 * Both checks are satisfied by adding the root's own address to the
 * browser-side `CardVerifier`'s `trustedRoots` — see `scenario.ts`. No
 * on-chain governance action registers "trusted roots"; it's purely local
 * verifier config, by design (`card_verifier.md §5`).
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import {
  deriveKeypair,
  InMemorySecureKeyProvider,
  buildPermissiveTestPolicy,
  pinJsonToKubo,
  mintCard,
  ensureGovernanceBootstrap,
  type GovernanceKeypair,
} from '@membership-card-protocol/integration-fixtures';
import { assembleAndSignTargetedOffer, keccak256, bytesToBase64Url, base64UrlToBytes } from '@membership-card-protocol/app-sdk';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../..');

/**
 * Parses a wrangler `.dev.vars` file (KEY=value per line, `#`-comments,
 * blank lines) — no library needed for this simple, well-known format.
 */
function parseDevVars(path: string): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const line of readFileSync(path, 'utf-8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    vars[trimmed.slice(0, eq)] = trimmed.slice(eq + 1);
  }
  return vars;
}

export interface HarnessConfig {
  pressBaseUrl: string;
  walletServiceBaseUrl: string;
  relayBaseUrl: string;
  arbitrumRpcUrl: string;
  storageContractAddress: string;
  policyId: string;
  policyAddress: string;
  pressAddress: string;
  rootCardAddress: string;
  rootCardPublicKeyB64: string;
  rootCardSecretKeyB64: string;
  offer: Record<string, unknown>;
  offerCid: string;
}

export interface PrepareOptions {
  pressBaseUrl: string;
  walletServiceBaseUrl: string;
  relayBaseUrl: string;
  arbitrumRpcUrl: string;
  storageContractAddress: string;
  kuboApiUrl: string;
}

export async function prepare(options: PrepareOptions): Promise<HarnessConfig> {
  const pressBaseUrl = options.pressBaseUrl.replace(/\/$/, '');

  const pressInfo = (await (await fetch(`${pressBaseUrl}/api/press`)).json()) as {
    press_card_cid: string;
    // The press's on-chain `PressAuthorizations` lookup key (gas-account
    // address, bytes32-padded) — a separate identity from `press_card_cid`
    // and from `address` (keccak256 of the ML-DSA-44 content-signing key;
    // see wallet-sdk's `offerVerification.ts` doc comment on why none of
    // these are derivable from one another).
    gas_address: string;
  };
  const policy = buildPermissiveTestPolicy(pressInfo.press_card_cid);
  const policyId = await pinJsonToKubo(options.kuboApiUrl, policy);
  const policyAddress = '0x' + keccak256(new TextEncoder().encode(policyId));

  // Local nitro-devnode resets all chain state on every restart, so —
  // unlike Sepolia, where this was already done once by hand — this
  // policy and this press need registering/authorizing on-chain before
  // any card can be minted under it. Idempotent: no-ops if already done.
  // See governanceBootstrap.ts's doc comment for the full rationale.
  const deploymentFile = join(REPO_ROOT, 'contracts/deployments/local.json');
  const deployment = JSON.parse(readFileSync(deploymentFile, 'utf-8')) as {
    contracts: { logic_contract: string; storage_contract: string };
    dev_governance_keypair: GovernanceKeypair;
  };
  const pressDevVars = parseDevVars(join(REPO_ROOT, 'integration_tests/env/press/.dev.vars'));

  await ensureGovernanceBootstrap({
    rpcUrl: options.arbitrumRpcUrl,
    logicAddress: deployment.contracts.logic_contract as `0x${string}`,
    storageAddress: deployment.contracts.storage_contract as `0x${string}`,
    policyAddress,
    pressAddress: pressInfo.gas_address as `0x${string}`,
    pressSecp256r1PrivateKey: pressDevVars.PRESS_SECP256R1_PRIVATE_KEY!,
    pressMlDsa44PrivateKey: base64UrlToBytes(pressDevVars.PRESS_MLDSA44_PRIVATE_KEY!),
    governanceKeypair: deployment.dev_governance_keypair,
    pressGasWalletPrivateKey: pressDevVars.PRESS_GAS_WALLET_PRIVATE_KEY!,
    contractsScriptsDir: join(REPO_ROOT, 'contracts/scripts'),
  });

  // Mint the root card via the exact same flow 2.1's fixtures already
  // proved end-to-end (real registerCard on Sepolia). A fresh label each
  // run avoids CARD_ALREADY_EXISTS; the policy above is a stable CID
  // (pure function of press_card_cid), so no new registerPolicy/
  // authorizePress governance calls are needed here.
  const label = `web-harness-root-${Date.now()}`;
  await mintCard({ pressBaseUrl, policyId, label, fieldValues: { display_name: 'Web Harness Root' } });
  const rootKeypair = deriveKeypair(`holder:${label}`);
  // Card addresses (as opposed to on-chain bytes32 args like policyAddress
  // below) are unprefixed lowercase hex throughout the offer/verifier
  // layer — see wallet-sdk's offerVerification.ts and
  // membership_card_verifier's CardVerifier, both of which compare
  // `keccak256(pubkey)` directly against `issuer_card`/`cardAddress` with
  // no `0x` prefix. `registryContract.ts` is responsible for re-adding the
  // prefix when it actually talks to viem.
  const rootAddress = keccak256(rootKeypair.publicKey);

  // Build and submit a targeted offer issued by that same root card:
  // ancestry_pubkeys=[rootPubkey] (root acts as its own immediate parent
  // for the *new* card being offered) is also what makes the offer's
  // issuer resolvable to the trusted root for reviewTargetedOffer's
  // binding check on the browser side. The signing key id must derive the
  // *same* keypair mintCard just registered on-chain as rootAddress
  // (`holder:${label}`, matching fixtures/mintCard.ts's own convention) —
  // not an independent one.
  const issuerKeyId = `holder:${label}`;
  const secureKeyProvider = new InMemorySecureKeyProvider();
  await secureKeyProvider.generateKey(issuerKeyId);

  const offer = await assembleAndSignTargetedOffer({
    secureKeyProvider,
    issuerSigningKeyId: issuerKeyId,
    policyId,
    issuerCard: rootAddress,
    // `handleIssueFinalize` (press/src/handlers/issue.ts:112-116)
    // unconditionally overwrites `press_card` with `PRESS_CARD_CID` before
    // re-verifying `holder_signature` — the offer must be signed with that
    // same CID or the signature check fails (confirmed empirically; the
    // on-chain registry `address` looked plausible but breaks this).
    pressCard: pressInfo.press_card_cid,
    ancestryPubkeys: [rootKeypair.publicKey],
    fieldValues: { display_name: 'Web Harness Membership' },
  });

  const issueRes = await fetch(`${pressBaseUrl}/api/issue`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ policy_cid: policyId, requester_card_address: rootAddress, offer }),
  });
  if (!issueRes.ok) {
    throw new Error(`prepare: POST /issue failed: HTTP ${issueRes.status}: ${await issueRes.text()}`);
  }
  const { offer_cid: offerCid } = (await issueRes.json()) as { offer_cid: string };

  return {
    pressBaseUrl,
    walletServiceBaseUrl: options.walletServiceBaseUrl.replace(/\/$/, ''),
    relayBaseUrl: options.relayBaseUrl.replace(/\/$/, ''),
    arbitrumRpcUrl: options.arbitrumRpcUrl,
    storageContractAddress: options.storageContractAddress,
    policyId,
    policyAddress,
    pressAddress: pressInfo.gas_address,
    rootCardAddress: rootAddress,
    rootCardPublicKeyB64: bytesToBase64Url(rootKeypair.publicKey),
    rootCardSecretKeyB64: bytesToBase64Url(rootKeypair.secretKey),
    offer: offer as unknown as Record<string, unknown>,
    offerCid,
  };
}
