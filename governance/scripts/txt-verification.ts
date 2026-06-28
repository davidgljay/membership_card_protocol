/**
 * Script A — TXT Verification
 *
 * Verifies domain ownership via _mcard.<domain> DNS TXT records,
 * issues a domain admin card, and registers the domain on-chain.
 *
 * Authorization: script key (1-of-1 DnsGovernanceBody quorum).
 * Route: POST /dns/verify
 *
 * Process spec: specs/process_specs/dns_governance_verifier.md §Script A
 * Contract ops: RegisterCard (§4.1), RegisterDomain (§4.17)
 */

import { promises as dns } from 'dns';
import { defineEventHandler, readBody, createError } from 'h3';
import { keccak_256 } from '@noble/hashes/sha3.js';
import type { Hex } from 'viem';
import { loadConfig, createIpfsClient } from './config.js';
import { createDnsGovRegistryClient } from './registry.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface VerificationRequest {
  /** Lowercase domain string, e.g. "example.com". No trailing dot. */
  domain: string;
  /** On-chain card address (hex bytes32). Must equal keccak256(ml_dsa_pubkey). */
  card_address: Hex;
  /** ML-DSA-44 public key (1312 bytes, base64url-encoded). */
  ml_dsa_pubkey: string;
  /** secp256r1 public key (64 bytes x||y, base64url-encoded) for sub-card authorization. */
  secp256r1_pubkey: string;
  /** The TXT record the applicant has set (for cross-verification and card document). */
  txt_record: string;
}

export interface VerificationResult {
  domain: string;
  card_address: Hex;
  tx_hash: Hex;
  registered_at: string;
}

// ---------------------------------------------------------------------------
// Domain admin card document structure (Q5)
// ---------------------------------------------------------------------------

interface DomainAdminCardDocument {
  /** Lowercase domain this card administers. */
  domain: string;
  /** The TXT record set on _mcard.<domain> at verification time. */
  txt: string;
  /** null = full-domain admin (no path restriction). Sub-cards may have a string regex. */
  dns_path_scope: null;
  /**
   * Auditor entries. The governance authority is always listed.
   * All sub-cards issued from this card MUST also include the authority.
   */
  auditors: Array<{ card_address: Hex; policy_address: Hex }>;
  /** ML-DSA-44 public key of the card holder (base64url, 1312 bytes). */
  ml_dsa_pubkey: string;
  /** On-chain policy address under which this card was issued. */
  policy_address: Hex;
  /** On-chain address of this card (keccak256 of ml_dsa_pubkey). */
  card_address: Hex;
  issued_at: string;
}

// ---------------------------------------------------------------------------
// Nitro event handler
// ---------------------------------------------------------------------------

export default defineEventHandler(async (event) => {
  const config = loadConfig();
  const registry = createDnsGovRegistryClient(config);

  const body = await readBody<VerificationRequest>(event);

  // Step 1: Validate request.
  const domain = (body.domain ?? '').toLowerCase().replace(/\.$/, '');
  if (!domain || domain.length > 255) {
    throw createError({ statusCode: 400, message: 'Invalid domain: must be 1–255 bytes, no trailing dot' });
  }
  if (!body.card_address || !/^0x[0-9a-fA-F]{64}$/.test(body.card_address)) {
    throw createError({ statusCode: 400, message: 'Invalid card_address: must be 0x-prefixed hex bytes32' });
  }
  const mlDsaPubkeyBytes = decodeBase64url(body.ml_dsa_pubkey, 1312);
  if (!mlDsaPubkeyBytes) {
    throw createError({ statusCode: 400, message: 'Invalid ml_dsa_pubkey: must be 1312-byte base64url' });
  }
  const secp256r1PubkeyBytes = decodeBase64url(body.secp256r1_pubkey, 64);
  if (!secp256r1PubkeyBytes) {
    throw createError({ statusCode: 400, message: 'Invalid secp256r1_pubkey: must be 64-byte base64url' });
  }

  // Step 2: Verify card address derivation.
  const expectedAddress = '0x' + Buffer.from(keccak_256(mlDsaPubkeyBytes)).toString('hex') as Hex;
  if (expectedAddress.toLowerCase() !== body.card_address.toLowerCase()) {
    throw createError({ statusCode: 400, message: 'card_address does not match keccak256(ml_dsa_pubkey)' });
  }

  // Step 3: Check domain not already registered with an active admin.
  const registration = await registry.getDomainRegistration(domain);
  if (registration.exists && registration.adminCardAddress !== '0x' + '00'.repeat(32)) {
    throw createError({
      statusCode: 409,
      message: 'Domain already has an active admin card. Complete admin-deactivation first.',
    });
  }

  // Step 4: Resolve TXT record with retry.
  const fingerprint = Buffer.from(keccak_256(mlDsaPubkeyBytes)).slice(0, 8).toString('hex');
  const expectedRecord = `mcard-verify=${body.card_address.slice(2).toLowerCase()}.${fingerprint}`;
  const txtResult = await resolveTxtWithRetry(domain, expectedRecord);
  if (!txtResult.matched) {
    throw createError({
      statusCode: 422,
      message: JSON.stringify({
        error: 'txt_record_not_found',
        domain,
        expected: expectedRecord,
        subdomain: `_mcard.${domain}`,
        attempts: txtResult.attempts,
      }),
    });
  }

  // Step 5: Instruct the press to issue the domain admin card.
  // The press handles IPFS pinning of the card document and the RegisterCard on-chain call.
  const cardDoc: DomainAdminCardDocument = {
    domain,
    txt: txtResult.matchedRecord,
    dns_path_scope: null,
    auditors: [{
      card_address: config.authorityCardAddress,
      policy_address: config.dnsPolicyAddress,
    }],
    ml_dsa_pubkey: body.ml_dsa_pubkey,
    policy_address: config.dnsPolicyAddress,
    card_address: body.card_address,
    issued_at: new Date().toISOString(),
  };

  const pressIssueRes = await fetch(`${config.pressUrl}/dns/admin-card`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ card_address: body.card_address, card_document: cardDoc }),
  });
  if (!pressIssueRes.ok) {
    const detail = await pressIssueRes.text();
    throw createError({ statusCode: 502, message: `Press card issuance failed (${pressIssueRes.status}): ${detail}` });
  }
  const { tx_hash: registerCardTxHash } = await pressIssueRes.json() as { tx_hash: string };
  console.log(`[txt-verification] RegisterCard tx: ${registerCardTxHash} — card ${body.card_address}`);

  // Step 7: Register domain via governance (1-of-1 script key).
  const registerDomainTxHash = await registry.registerDomain(
    domain,
    body.card_address,
    secp256r1PubkeyBytes,
  );
  console.log(`[txt-verification] RegisterDomain tx: ${registerDomainTxHash} — domain ${domain}`);

  const result: VerificationResult = {
    domain,
    card_address: body.card_address,
    tx_hash: registerDomainTxHash,
    registered_at: new Date().toISOString(),
  };
  return result;
});

// ---------------------------------------------------------------------------
// DNS TXT resolution
// ---------------------------------------------------------------------------

interface TxtResult {
  matched: boolean;
  matchedRecord: string;
  attempts: number;
}

async function resolveTxtWithRetry(domain: string, expectedRecord: string): Promise<TxtResult> {
  const subdomain = `_mcard.${domain}`;
  const delays = [0, 30_000, 60_000, 120_000];

  for (let attempt = 0; attempt < delays.length; attempt++) {
    const delay = delays[attempt] ?? 0;
    if (delay > 0) await sleep(delay);

    try {
      // Node.js resolver: returns string[][] (each TXT record is an array of strings to join)
      const resolver = new dns.Resolver();
      const records = await resolver.resolveTxt(subdomain);
      const flat = records.map(chunks => chunks.join(''));

      console.log(`[txt-verification] Attempt ${attempt + 1}: resolved ${flat.length} TXT record(s) at ${subdomain}`);

      const match = flat.find(r => r === expectedRecord);
      if (match) {
        return { matched: true, matchedRecord: match, attempts: attempt + 1 };
      }

      // Also try DoH as a fallback for Workers/edge environments.
      // (In a Cloudflare Worker, replace the dns.Resolver call above with this.)
      // const dohResult = await resolveTxtViaDoH(subdomain, expectedRecord);
      // if (dohResult) return { matched: true, matchedRecord: dohResult, attempts: attempt + 1 };

    } catch (err) {
      // ENOTFOUND = subdomain doesn't exist yet; ENODATA = exists but no TXT records.
      // Both are retryable (propagation delay).
      const code = (err as { code?: string }).code;
      if (code !== 'ENOTFOUND' && code !== 'ENODATA') {
        console.warn(`[txt-verification] DNS query error (attempt ${attempt + 1}): ${String(err)}`);
      } else {
        console.log(`[txt-verification] Attempt ${attempt + 1}: ${code} at ${subdomain} (may be propagation delay)`);
      }
    }
  }

  return { matched: false, matchedRecord: '', attempts: delays.length };
}

// Cloudflare Workers / edge alternative for environments without Node.js `dns` module:
// async function resolveTxtViaDoH(subdomain: string, expected: string): Promise<string | null> {
//   const url = `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(subdomain)}&type=TXT`;
//   const res = await fetch(url, { headers: { Accept: 'application/dns-json' } });
//   if (!res.ok) return null;
//   const data = await res.json() as { Answer?: Array<{ data: string }> };
//   const records = (data.Answer ?? []).map(a => a.data.replace(/^"|"$/g, ''));
//   return records.find(r => r === expected) ?? null;
// }

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

function decodeBase64url(encoded: string, expectedLength: number): Uint8Array | null {
  try {
    const bytes = Buffer.from(encoded ?? '', 'base64url');
    return bytes.length === expectedLength ? new Uint8Array(bytes) : null;
  } catch {
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
