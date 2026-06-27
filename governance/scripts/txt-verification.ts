/**
 * Script A — TXT Verification
 *
 * Nitro event handler for DNS TXT record verification requests.
 * Verifies domain ownership via _mcard.<domain> TXT records, issues a domain admin card,
 * and registers the domain on-chain via RegisterDomain (§4.17).
 *
 * Process spec: specs/process_specs/dns_governance_verifier.md §Script A
 * Contract ops:  RegisterCard (§4.1), RegisterDomain (§4.17)
 *
 * Route: POST /dns/verify
 * See nitro.config.ts example below for deployment.
 */

import { createPublicClient, createWalletClient, http, keccak256, encodeFunctionData, type Hex } from 'viem';
import { arbitrum } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import { defineEventHandler, readBody, createError } from 'h3';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Incoming request payload from the domain applicant. */
export interface VerificationRequest {
  /** Lowercase domain string, e.g. "example.com". No trailing dot. */
  domain: string;
  /** On-chain card address (hex bytes32) — must equal keccak256(ml_dsa_pubkey). */
  card_address: Hex;
  /** ML-DSA-44 public key (1312 bytes, base64url-encoded). */
  ml_dsa_pubkey: string;
  /** secp256r1 public key (64 bytes x||y, base64url-encoded) for on-chain sub-card authorization. */
  secp256r1_pubkey: string;
}

/** Response returned on successful verification and registration. */
export interface VerificationResult {
  domain: string;
  card_address: Hex;
  tx_hash: Hex;
  registered_at: string;
}

/** Intermediate state of a TXT record query attempt. */
interface TxtQueryResult {
  records: string[];
  matched: boolean;
  attempt: number;
}

// ---------------------------------------------------------------------------
// Config (loaded from environment)
// ---------------------------------------------------------------------------

function loadConfig() {
  const required = (name: string): string => {
    const val = process.env[name];
    if (!val) throw new Error(`Missing required env var: ${name}`);
    return val;
  };
  return {
    registryAddress:      required('REGISTRY_ADDRESS') as Hex,
    rpcUrl:               required('RPC_URL'),
    govPrivateKey:        required('DNS_GOV_PRIVATE_KEY') as Hex,
    dnsPolicyAddress:     required('DNS_GOV_POLICY_ADDRESS') as Hex,
    pressAddress:         required('PRESS_ADDRESS') as Hex,
    pressPrivateKey:      required('PRESS_PRIVATE_KEY') as Hex,
    ipfsGatewayUrl:       required('IPFS_GATEWAY_URL'),
  };
}

// ---------------------------------------------------------------------------
// Nitro event handler
// ---------------------------------------------------------------------------

export default defineEventHandler(async (event) => {
  const config = loadConfig();
  const body = await readBody<VerificationRequest>(event);

  // Step 1: Validate request.
  if (!body.domain || body.domain.length > 255) {
    throw createError({ statusCode: 400, message: 'Invalid domain: must be 1–255 bytes' });
  }
  if (!body.card_address || !body.card_address.startsWith('0x') || body.card_address.length !== 66) {
    throw createError({ statusCode: 400, message: 'Invalid card_address: must be hex bytes32' });
  }
  const mlDsaPubkeyBytes = tryDecodeBase64url(body.ml_dsa_pubkey, 1312);
  if (!mlDsaPubkeyBytes) {
    throw createError({ statusCode: 400, message: 'Invalid ml_dsa_pubkey: must be 1312-byte base64url' });
  }
  const secp256r1PubkeyBytes = tryDecodeBase64url(body.secp256r1_pubkey, 64);
  if (!secp256r1PubkeyBytes) {
    throw createError({ statusCode: 400, message: 'Invalid secp256r1_pubkey: must be 64-byte base64url' });
  }

  // Step 2: Verify card address derivation.
  const expectedAddress = keccak256(mlDsaPubkeyBytes) as Hex;
  if (expectedAddress.toLowerCase() !== body.card_address.toLowerCase()) {
    throw createError({ statusCode: 400, message: 'card_address does not match keccak256(ml_dsa_pubkey)' });
  }

  const publicClient = createPublicClient({ chain: arbitrum, transport: http(config.rpcUrl) });

  // Step 3: Check domain not already registered.
  // TODO: Call GetDomainRegistration(domain) on the storage contract.
  // If exists == true && admin_card_address != bytes32(0), return HTTP 409.
  const domainRegistration = await getDomainRegistration(publicClient, config.registryAddress, body.domain);
  if (domainRegistration.exists && domainRegistration.adminCardAddress !== '0x' + '00'.repeat(32)) {
    throw createError({ statusCode: 409, message: 'Domain already has an active admin card. Complete admin deactivation first.' });
  }

  // Step 4: Resolve TXT record with retry.
  const txtResult = await resolveTxtWithRetry(body.domain, body.card_address, mlDsaPubkeyBytes);
  if (!txtResult.matched) {
    throw createError({
      statusCode: 422,
      message: JSON.stringify({ error: 'txt_record_not_found', domain: body.domain, attempts: txtResult.attempt }),
    });
  }

  // Step 5: Issue domain admin card via press.
  // TODO: Write genesis card document to IPFS (including ml_dsa_pubkey and auditor entry).
  // TODO: Call RegisterCard via press wallet and wait for confirmation.
  const cardAddress = body.card_address;
  const cardLogCid = await writeGenesisCardDocument(config.ipfsGatewayUrl, {
    cardAddress,
    mlDsaPubkey: body.ml_dsa_pubkey,
    domain: body.domain,
  });
  const pressAccount = privateKeyToAccount(config.pressPrivateKey);
  const pressClient = createWalletClient({ account: pressAccount, chain: arbitrum, transport: http(config.rpcUrl) });
  // TODO: Construct and submit RegisterCard transaction.
  // const registerCardTxHash = await submitRegisterCard(pressClient, config, cardAddress, cardLogCid);
  // await publicClient.waitForTransactionReceipt({ hash: registerCardTxHash });

  // Step 6: Call RegisterDomain with governance quorum.
  const govAccount = privateKeyToAccount(config.govPrivateKey);
  const govClient = createWalletClient({ account: govAccount, chain: arbitrum, transport: http(config.rpcUrl) });
  // TODO: Construct RegisterDomainPayload, sign with govPrivateKey, submit transaction.
  // const registerDomainTxHash = await submitRegisterDomain(govClient, config, body.domain, cardAddress, secp256r1PubkeyBytes);
  // const receipt = await publicClient.waitForTransactionReceipt({ hash: registerDomainTxHash });

  // Step 7: Return result.
  const result: VerificationResult = {
    domain: body.domain,
    card_address: cardAddress,
    tx_hash: '0x' + '00'.repeat(32) as Hex, // TODO: replace with actual tx hash
    registered_at: new Date().toISOString(),
  };
  return result;
});

// ---------------------------------------------------------------------------
// TXT record verification
// ---------------------------------------------------------------------------

/** Retry TXT record resolution up to 3 times with exponential backoff. */
async function resolveTxtWithRetry(
  domain: string,
  cardAddress: Hex,
  mlDsaPubkeyBytes: Uint8Array,
): Promise<TxtQueryResult> {
  const subdomain = `_mcard.${domain}`;
  const expectedFingerprint = Buffer.from(keccak256(mlDsaPubkeyBytes).slice(2), 'hex').slice(0, 8).toString('hex');
  const expectedRecord = `mcard-verify=${cardAddress.slice(2).toLowerCase()}.${expectedFingerprint}`;

  const delays: number[] = [0, 30_000, 60_000, 120_000]; // 0s (immediate), 30s, 60s, 120s
  for (let attempt = 0; attempt < delays.length; attempt++) {
    const delay = delays[attempt] ?? 0;
    if (delay > 0) {
      await sleep(delay);
    }
    try {
      const records = await queryTxtRecords(subdomain);
      if (records.some((r) => r === expectedRecord)) {
        return { records, matched: true, attempt: attempt + 1 };
      }
      console.log(`[txt-verification] Attempt ${attempt + 1}: no matching TXT record at ${subdomain}. Found: ${JSON.stringify(records)}`);
    } catch (err) {
      console.warn(`[txt-verification] DNS query failed on attempt ${attempt + 1}:`, err);
    }
  }
  return { records: [], matched: false, attempt: 4 };
}

/**
 * Query TXT records for a subdomain.
 * TODO: Implement using a real DNS-over-HTTPS resolver (e.g. Cloudflare, Google).
 * In Node.js, use dns.promises.resolveTxt(). In Cloudflare Workers, use DoH fetch.
 */
async function queryTxtRecords(subdomain: string): Promise<string[]> {
  // TODO: Replace with actual DNS query implementation.
  // Node.js: const { Resolver } = await import('dns/promises'); const r = new Resolver(); return (await r.resolveTxt(subdomain)).flat();
  // Cloudflare Workers: const resp = await fetch(`https://cloudflare-dns.com/dns-query?name=${subdomain}&type=TXT`, { headers: { Accept: 'application/dns-json' } });
  throw new Error('TODO: implement DNS TXT resolution');
}

// ---------------------------------------------------------------------------
// On-chain helpers (stubs)
// ---------------------------------------------------------------------------

interface DomainRegistrationResult {
  exists: boolean;
  adminCardAddress: Hex;
}

/** Call GetDomainRegistration on the storage contract. */
async function getDomainRegistration(
  client: ReturnType<typeof createPublicClient>,
  registryAddress: Hex,
  domain: string,
): Promise<DomainRegistrationResult> {
  // TODO: Call getDomainEntry(keccak256(domain_bytes)) on the storage contract.
  // const domainHash = keccak256(new TextEncoder().encode(domain));
  // const [admin,,,,exists] = await client.readContract({ address: registryAddress, abi: STORAGE_ABI, functionName: 'getDomainEntry', args: [domainHash] });
  // return { exists, adminCardAddress: admin };
  return { exists: false, adminCardAddress: '0x' + '00'.repeat(32) as Hex }; // TODO: replace stub
}

/** Write genesis card document to IPFS and return its CID. */
async function writeGenesisCardDocument(
  _ipfsGatewayUrl: string,
  _params: { cardAddress: Hex; mlDsaPubkey: string; domain: string },
): Promise<string> {
  // TODO: Construct and upload the genesis card document.
  // The document must include: ml_dsa_pubkey, domain admin role marker, dns_governance_authority as auditor.
  // Return the CID of the uploaded document.
  throw new Error('TODO: implement IPFS genesis card document upload');
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

function tryDecodeBase64url(encoded: string, expectedLength: number): Uint8Array | null {
  try {
    const bytes = Buffer.from(encoded, 'base64url');
    return bytes.length === expectedLength ? new Uint8Array(bytes) : null;
  } catch {
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// nitro.config.ts example
// ---------------------------------------------------------------------------
//
// import { defineNitroConfig } from 'nitropack/config';
// export default defineNitroConfig({
//   routeRules: {
//     '/dns/**': { cors: false }
//   },
//   runtimeConfig: {
//     REGISTRY_ADDRESS: '',
//     RPC_URL: '',
//     DNS_GOV_PRIVATE_KEY: '',
//     DNS_GOV_POLICY_ADDRESS: '',
//     PRESS_ADDRESS: '',
//     PRESS_PRIVATE_KEY: '',
//     IPFS_GATEWAY_URL: '',
//   }
// });
