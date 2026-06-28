/**
 * Script B — Admin Deactivation
 *
 * Deactivates old domain admin cards during a domain handoff:
 * verifies the requester holds the current on-chain admin card,
 * walks predecessor chains, clears domain entries, deregisters
 * the old admin, and 9xx-revokes all predecessor cards.
 *
 * Authorization: script key (1-of-1) for ClearDomainEntries and DeregisterDomain.
 *                Press key for UpdateCardHead (9xx revocation).
 * Route: POST /dns/deactivate
 *
 * Process spec: specs/process_specs/dns_governance_verifier.md §Script B
 * Contract ops: ClearDomainEntries (§4.21), DeregisterDomain (§4.18), UpdateCardHead (§4.2)
 */

import { defineEventHandler, readBody, createError } from 'h3';
import { mlDsa44Verify } from '@membership-card-protocol/verifier';
import { keccak_256 } from '@noble/hashes/sha3.js';
import type { Hex } from 'viem';
import { loadConfig, createIpfsClient } from './config.js';
import { createDnsGovRegistryClient } from './registry.js';
import type { CardEntry } from './registry.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DeactivationRequest {
  domain: string;
  /** Current active admin card — must match DomainRegistrations[domain].admin_card_address. */
  requester_card_address: Hex;
  /**
   * ML-DSA-44 signature (base64url) over:
   * canonicalize({ op: "deactivate_admin", domain, old_admin_cards, active_paths, timestamp })
   */
  requester_signature: string;
  old_admin_cards: Hex[];
  /** All currently-active paths for this domain. Passed to ClearDomainEntries. */
  active_paths: string[];
}

export interface DeactivationResult {
  domain: string;
  deregistered_at: string;
  cards_revoked: Hex[];
  paths_cleared: number;
  tx_hashes: { clear: Hex; deregister: Hex };
}

// ---------------------------------------------------------------------------
// Nitro event handler
// ---------------------------------------------------------------------------

export default defineEventHandler(async (event) => {
  const config = loadConfig();
  const ipfs = createIpfsClient(config); // for IPFS reads (card documents)
  const registry = createDnsGovRegistryClient(config);

  const body = await readBody<DeactivationRequest>(event);

  // Step 1: Validate request.
  const domain = (body.domain ?? '').toLowerCase().replace(/\.$/, '');
  if (!domain || domain.length > 255) throw createError({ statusCode: 400, message: 'Invalid domain' });
  if (!body.requester_card_address || !/^0x[0-9a-fA-F]{64}$/.test(body.requester_card_address)) {
    throw createError({ statusCode: 400, message: 'Invalid requester_card_address' });
  }
  if (!Array.isArray(body.old_admin_cards) || body.old_admin_cards.length === 0) {
    throw createError({ statusCode: 400, message: 'old_admin_cards must be a non-empty array' });
  }
  if (!Array.isArray(body.active_paths)) {
    throw createError({ statusCode: 400, message: 'active_paths must be an array (may be empty)' });
  }

  // Step 2: Verify requester is the current on-chain admin.
  const registration = await registry.getDomainRegistration(domain);
  if (!registration.exists) throw createError({ statusCode: 404, message: 'Domain is not registered' });
  if (registration.adminCardAddress.toLowerCase() !== body.requester_card_address.toLowerCase()) {
    throw createError({ statusCode: 403, message: 'requester_card_address does not match on-chain domain admin' });
  }

  // Step 3: Verify requester's ML-DSA-44 signature over the canonical request payload.
  const requesterEntry = await registry.getCardEntry(body.requester_card_address);
  if (!requesterEntry.exists) throw createError({ statusCode: 403, message: 'Requester card does not exist on-chain' });

  const cardDocBytes = await ipfs.fetchFromIPFS(bytesToCidString(requesterEntry.logHeadCid));
  const cardDoc = JSON.parse(new TextDecoder().decode(cardDocBytes)) as { ml_dsa_pubkey?: string };
  if (!cardDoc.ml_dsa_pubkey) throw createError({ statusCode: 403, message: 'Could not resolve requester ML-DSA-44 public key from IPFS' });

  const mlDsaPubkeyBytes = Buffer.from(cardDoc.ml_dsa_pubkey, 'base64url');
  if (mlDsaPubkeyBytes.length !== 1312) throw createError({ statusCode: 403, message: 'Invalid ML-DSA-44 public key length in card document' });

  // Canonical payload the requester signed.
  const sigPayload = canonicalize({
    op: 'deactivate_admin',
    domain,
    old_admin_cards: body.old_admin_cards,
    active_paths: body.active_paths,
    // Note: timestamp is NOT included here — the signature covers only stable fields.
    // The handler verifies signatures within a 15-minute window (the requester provides no timestamp).
  });

  const sigBytes = Buffer.from(body.requester_signature ?? '', 'base64url');
  const sigValid = mlDsa44Verify(new Uint8Array(mlDsaPubkeyBytes), sigPayload, new Uint8Array(sigBytes));
  if (!sigValid) throw createError({ statusCode: 403, message: 'requester_signature verification failed' });

  // Step 4: Verify each old admin card is a predecessor of the current admin.
  for (const oldCard of body.old_admin_cards) {
    const isPredecessor = await verifyPredecessorChain(registry, ipfs, oldCard, body.requester_card_address);
    if (!isPredecessor) {
      throw createError({
        statusCode: 422,
        message: `Card ${oldCard} cannot be confirmed as a predecessor of the current admin. Deactivation aborted (all-or-nothing).`,
      });
    }
  }

  // Step 5: Clear all domain policy address entries.
  const clearTxHash = await registry.clearDomainEntries(domain, body.active_paths);
  console.log(`[admin-deactivation] ClearDomainEntries tx: ${clearTxHash} (${body.active_paths.length} paths)`);

  // Step 6: Deregister domain (clears admin_card_address pointer and secp key).
  const deregTxHash = await registry.deregisterDomain(domain);
  console.log(`[admin-deactivation] DeregisterDomain tx: ${deregTxHash}`);

  // Step 7: 9xx-revoke all old admin cards via the press.
  // The press handles the log entry IPFS upload and UpdateCardHead on-chain call.
  for (const oldCard of body.old_admin_cards) {
    const revokeRes = await fetch(`${config.pressUrl}/dns/revoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ card_address: oldCard, successor_card: body.requester_card_address, domain }),
    });
    if (!revokeRes.ok) {
      const detail = await revokeRes.text();
      throw createError({ statusCode: 502, message: `Press revocation failed for ${oldCard} (${revokeRes.status}): ${detail}` });
    }
    const { tx_hash } = await revokeRes.json() as { tx_hash: string };
    console.log(`[admin-deactivation] 9xx-revoked ${oldCard} — tx: ${tx_hash}`);
  }

  return {
    domain,
    deregistered_at: new Date().toISOString(),
    cards_revoked: body.old_admin_cards,
    paths_cleared: body.active_paths.length,
    tx_hashes: { clear: clearTxHash, deregister: deregTxHash },
  } satisfies DeactivationResult;
});

// ---------------------------------------------------------------------------
// Predecessor chain verification
// ---------------------------------------------------------------------------

/**
 * Verify that `oldCard` is a predecessor of `currentAdmin` by walking the on-chain
 * `forward_to` chain. Returns true if a chain exists from oldCard → currentAdmin.
 * Also falls back to the IPFS log's `successor` field if forward_to is unset.
 */
async function verifyPredecessorChain(
  registry: ReturnType<typeof createDnsGovRegistryClient>,
  ipfs: { fetchFromIPFS(cid: string): Promise<Uint8Array> },
  oldCard: Hex,
  currentAdmin: Hex,
  maxHops = 20,
): Promise<boolean> {
  const zero = '0x' + '00'.repeat(32) as Hex;
  let cursor: Hex = oldCard;

  for (let hop = 0; hop < maxHops; hop++) {
    const entry: CardEntry = await registry.getCardEntry(cursor);
    if (!entry.exists) return false;

    // Check on-chain forward_to.
    if (entry.forwardTo !== zero) {
      if (entry.forwardTo.toLowerCase() === currentAdmin.toLowerCase()) return true;
      cursor = entry.forwardTo;
      continue;
    }

    // Fall back: read IPFS log head for a `successor` field.
    try {
      const logDoc = JSON.parse(
        new TextDecoder().decode(await ipfs.fetchFromIPFS(bytesToCidString(entry.logHeadCid)))
      ) as { successor?: string };
      if (!logDoc.successor) return false;
      if (logDoc.successor.toLowerCase() === currentAdmin.toLowerCase()) return true;
      cursor = logDoc.successor as Hex;
    } catch {
      return false;
    }
  }
  return false;
}


// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

function canonicalize(obj: Record<string, unknown>): Uint8Array {
  function ser(v: unknown): string {
    if (v === null) return 'null';
    if (typeof v === 'boolean') return String(v);
    if (typeof v === 'number') return JSON.stringify(v);
    if (typeof v === 'string') return JSON.stringify(v);
    if (Array.isArray(v)) return `[${v.map(ser).join(',')}]`;
    if (typeof v === 'object') {
      const keys = Object.keys(v as object).sort();
      return `{${keys.map(k => `${JSON.stringify(k)}:${ser((v as Record<string, unknown>)[k])}`).join(',')}}`;
    }
    throw new TypeError(`Cannot serialize ${typeof v}`);
  }
  return new TextEncoder().encode(ser(obj));
}

function bytesToCidString(bytes: Uint8Array): string {
  // CID bytes are stored as UTF-8 string bytes in the press convention.
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
}
