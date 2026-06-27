/**
 * Script B — Admin Deactivation
 *
 * Nitro event handler for domain admin chain deactivation requests during domain handoff.
 * Verifies the requester holds the current on-chain admin card, walks predecessor chains,
 * clears domain entries, deregisters the old admin, and 9xx-revokes all predecessor cards.
 *
 * Process spec: specs/process_specs/dns_governance_verifier.md §Script B
 * Contract ops:  ClearDomainEntries (§4.21), DeregisterDomain (§4.18), UpdateCardHead (§4.2)
 *
 * Route: POST /dns/deactivate
 */

import { createPublicClient, createWalletClient, http, keccak256, type Hex } from 'viem';
import { arbitrum } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import { defineEventHandler, readBody, createError } from 'h3';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Incoming request from the current domain admin. */
export interface DeactivationRequest {
  /** Lowercase domain string. */
  domain: string;
  /** On-chain address of the current active admin card — must match DomainRegistrations[domain].admin_card_address. */
  requester_card_address: Hex;
  /** ML-DSA-44 signature over canonical request payload (base64url). */
  requester_signature: string;
  /** List of old admin card addresses to 9xx-revoke. */
  old_admin_cards: Hex[];
  /** All currently-active policy address paths for this domain (used for ClearDomainEntries). */
  active_paths: string[];
}

/** Response returned on successful deactivation. */
export interface DeactivationResult {
  domain: string;
  deregistered_at: string;
  cards_revoked: Hex[];
  paths_cleared: number;
  tx_hashes: {
    clear: Hex;
    deregister: Hex;
  };
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

function loadConfig() {
  const required = (name: string): string => {
    const val = process.env[name];
    if (!val) throw new Error(`Missing required env var: ${name}`);
    return val;
  };
  return {
    registryAddress:  required('REGISTRY_ADDRESS') as Hex,
    rpcUrl:           required('RPC_URL'),
    govPrivateKey:    required('DNS_GOV_PRIVATE_KEY') as Hex,
    pressPrivateKey:  required('PRESS_PRIVATE_KEY') as Hex,
    ipfsGatewayUrl:   required('IPFS_GATEWAY_URL'),
  };
}

// ---------------------------------------------------------------------------
// Nitro event handler
// ---------------------------------------------------------------------------

export default defineEventHandler(async (event) => {
  const config = loadConfig();
  const body = await readBody<DeactivationRequest>(event);

  // Step 1: Validate request.
  if (!body.domain || body.domain.length > 255) {
    throw createError({ statusCode: 400, message: 'Invalid domain' });
  }
  if (!body.requester_card_address || body.requester_card_address.length !== 66) {
    throw createError({ statusCode: 400, message: 'Invalid requester_card_address' });
  }
  if (!body.old_admin_cards || body.old_admin_cards.length === 0) {
    throw createError({ statusCode: 400, message: 'old_admin_cards must be non-empty' });
  }
  if (!body.active_paths) {
    throw createError({ statusCode: 400, message: 'active_paths must be provided (may be empty array)' });
  }

  const publicClient = createPublicClient({ chain: arbitrum, transport: http(config.rpcUrl) });

  // Step 2: Verify requester is current on-chain admin.
  const registration = await getDomainRegistration(publicClient, config.registryAddress, body.domain);
  if (!registration.exists) {
    throw createError({ statusCode: 404, message: 'Domain is not registered' });
  }
  if (registration.adminCardAddress.toLowerCase() !== body.requester_card_address.toLowerCase()) {
    throw createError({ statusCode: 403, message: 'requester_card_address does not match on-chain domain admin' });
  }

  // Step 3: Verify requester holds the card key (ML-DSA-44 signature check).
  const requesterCardDocument = await fetchCardDocument(config.ipfsGatewayUrl, publicClient, config.registryAddress, body.requester_card_address);
  const signatureValid = await verifyRequesterSignature(
    requesterCardDocument.ml_dsa_pubkey,
    body.requester_signature,
    body,
  );
  if (!signatureValid) {
    throw createError({ statusCode: 403, message: 'requester_signature verification failed' });
  }

  // Step 4: Verify each old admin card is a predecessor in the chain.
  for (const oldCard of body.old_admin_cards) {
    const isPredecessor = await verifyPredecessorChain(
      publicClient,
      config.registryAddress,
      config.ipfsGatewayUrl,
      oldCard,
      body.requester_card_address,
    );
    if (!isPredecessor) {
      throw createError({
        statusCode: 422,
        message: `Card ${oldCard} cannot be confirmed as a predecessor of the current admin. Deactivation aborted.`,
      });
    }
  }

  // Step 5: Clear domain entries (all active paths).
  // TODO: Construct ClearDomainEntriesPayload, sign with govPrivateKey, submit.
  const govAccount = privateKeyToAccount(config.govPrivateKey);
  const govClient = createWalletClient({ account: govAccount, chain: arbitrum, transport: http(config.rpcUrl) });
  const clearTxHash = await submitClearDomainEntries(govClient, config.registryAddress, body.domain, body.active_paths);
  await publicClient.waitForTransactionReceipt({ hash: clearTxHash });

  // Step 6: Deregister domain (clear admin pointer).
  // TODO: Construct DeregisterDomainPayload, sign with govPrivateKey, submit.
  const deregTxHash = await submitDeregisterDomain(govClient, config.registryAddress, body.domain);
  await publicClient.waitForTransactionReceipt({ hash: deregTxHash });

  // Step 7: 9xx-revoke all old admin cards.
  const pressAccount = privateKeyToAccount(config.pressPrivateKey);
  const pressClient = createWalletClient({ account: pressAccount, chain: arbitrum, transport: http(config.rpcUrl) });
  for (const oldCard of body.old_admin_cards) {
    // TODO: Write 9xx revocation log entry to IPFS, then submit UpdateCardHead.
    await revokeCardWith9xx(pressClient, publicClient, config, oldCard, body.requester_card_address);
  }

  // Step 8: Return result.
  const result: DeactivationResult = {
    domain: body.domain,
    deregistered_at: new Date().toISOString(),
    cards_revoked: body.old_admin_cards,
    paths_cleared: body.active_paths.length,
    tx_hashes: { clear: clearTxHash, deregister: deregTxHash },
  };
  return result;
});

// ---------------------------------------------------------------------------
// On-chain helpers (stubs)
// ---------------------------------------------------------------------------

interface DomainRegistrationResult {
  exists: boolean;
  adminCardAddress: Hex;
}

async function getDomainRegistration(
  client: ReturnType<typeof createPublicClient>,
  registryAddress: Hex,
  domain: string,
): Promise<DomainRegistrationResult> {
  // TODO: Call getDomainEntry(keccak256(domain_bytes)) on the storage contract.
  void client; void registryAddress; void domain;
  return { exists: false, adminCardAddress: '0x' + '00'.repeat(32) as Hex }; // TODO: replace stub
}

interface CardDocument {
  ml_dsa_pubkey: string; // base64url ML-DSA-44 public key
}

async function fetchCardDocument(
  _ipfsGatewayUrl: string,
  _client: ReturnType<typeof createPublicClient>,
  _registryAddress: Hex,
  _cardAddress: Hex,
): Promise<CardDocument> {
  // TODO: Call GetCardEntry(cardAddress) to get log_head_cid, then fetch from IPFS.
  throw new Error('TODO: implement card document fetch from IPFS');
}

/**
 * Verify ML-DSA-44 signature over the canonical deactivation request payload.
 * The payload is canonical JSON of { op, domain, old_admin_cards, active_paths, timestamp }.
 */
async function verifyRequesterSignature(
  _mlDsaPubkey: string,
  _signature: string,
  _request: DeactivationRequest,
): Promise<boolean> {
  // TODO: Implement ML-DSA-44 signature verification.
  // Use the ml-dsa-44 library (same as used in membership_card_verifier).
  // const pubkeyBytes = decodeBase64url(_mlDsaPubkey);
  // const sigBytes = decodeBase64url(_signature);
  // const payload = canonicalize({ op: 'deactivate_admin', domain: _request.domain, ... });
  // return mlDsa44Verify(pubkeyBytes, new TextEncoder().encode(payload), sigBytes);
  throw new Error('TODO: implement ML-DSA-44 signature verification');
}

/**
 * Verify that oldCard is a predecessor of currentAdmin by walking the on-chain
 * forward_to chain and/or the IPFS log successor chain.
 * Returns true only if a confirmed chain exists from oldCard to currentAdmin.
 */
async function verifyPredecessorChain(
  _client: ReturnType<typeof createPublicClient>,
  _registryAddress: Hex,
  _ipfsGatewayUrl: string,
  _oldCard: Hex,
  _currentAdmin: Hex,
): Promise<boolean> {
  // TODO: Walk the forward_to chain:
  // let cursor = _oldCard;
  // while (cursor !== bytes32(0)) {
  //   const entry = await client.readContract({ functionName: 'getCardEntry', args: [cursor] });
  //   if (entry.forward_to.toLowerCase() === _currentAdmin.toLowerCase()) return true;
  //   cursor = entry.forward_to;
  // }
  // Also walk IPFS log for successor references as a fallback.
  throw new Error('TODO: implement predecessor chain verification');
}

async function submitClearDomainEntries(
  _client: ReturnType<typeof createWalletClient>,
  _registryAddress: Hex,
  _domain: string,
  _paths: string[],
): Promise<Hex> {
  // TODO: Construct and sign ClearDomainEntriesPayload with governance key.
  // Submit ClearDomainEntries(domain, paths, governance_payload, [governance_sig]).
  throw new Error('TODO: implement ClearDomainEntries submission');
}

async function submitDeregisterDomain(
  _client: ReturnType<typeof createWalletClient>,
  _registryAddress: Hex,
  _domain: string,
): Promise<Hex> {
  // TODO: Construct and sign DeregisterDomainPayload with governance key.
  // Submit DeregisterDomain(domain, governance_payload, [governance_sig]).
  throw new Error('TODO: implement DeregisterDomain submission');
}

async function revokeCardWith9xx(
  _pressClient: ReturnType<typeof createWalletClient>,
  _publicClient: ReturnType<typeof createPublicClient>,
  _config: ReturnType<typeof loadConfig>,
  _oldCard: Hex,
  _successorCard: Hex,
): Promise<void> {
  // TODO:
  // 1. Fetch current log head CID for oldCard.
  // 2. Write a 9xx revocation log entry to IPFS, referencing successorCard.
  // 3. Submit UpdateCardHead(oldCard, new_cid, prev_cid, press_payload, press_sig).
  throw new Error('TODO: implement 9xx card revocation');
}

// ---------------------------------------------------------------------------
// nitro.config.ts example (same as txt-verification)
// ---------------------------------------------------------------------------
//
// Route: POST /dns/deactivate
// See txt-verification.ts for the full nitro.config.ts example.
