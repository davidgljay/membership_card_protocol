/**
 * Script C — Policy Address Verifier
 *
 * Continuous polling task that monitors PolicyAddressSet events on-chain and
 * verifies each entry within a 24-hour SLA. Removes unauthorized entries,
 * queues fraudulent press reports for PressRegistryBody.
 *
 * Process spec: specs/process_specs/dns_governance_verifier.md §Script C
 * Contract ops:  GovernanceSetPolicyAddress (§4.23), RemovePolicyAddress (§4.20),
 *                FlagDomainFraudRisk (§4.22), ClearDomainEntries (§4.21)
 *
 * Deployment: Nitro scheduled task (runs every POLL_INTERVAL_MS).
 * See nitro.config.ts example at the bottom of this file.
 */

import { createPublicClient, createWalletClient, http, type Hex, type Log } from 'viem';
import { arbitrum } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
// defineTask is the Nitro 2.x task API (available in the Nitro server runtime context).
// When deploying as a Nitro task, place this file in tasks/ and Nitro auto-discovers it.
// The shape below matches the Nitro 2.x task interface.
const defineTask = (task: { meta: { name: string; description: string }; run: () => Promise<unknown> }) => task;
import { readFile, writeFile } from 'fs/promises';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Parsed PolicyAddressSet event from the logic contract (§7). */
export interface PolicyAddressSetEvent {
  domain: string;
  path: string;
  policy_card_address: Hex;
  admin_card_address: Hex;
  sub_card_address: Hex;
  press_address: Hex;
  block_number: bigint;
  log_index: number;
  /** ISO 8601 timestamp when this event was first observed by the verifier. */
  observed_at: string;
}

/** Result of verifying a single PolicyAddressSet event. */
export type VerificationOutcome =
  | 'VERIFIED'
  | 'FAILED_POLICY_CARD_NOT_FOUND'
  | 'FAILED_SCOPE_VIOLATION'
  | 'FAILED_BRAND_NAME_IMPERSONATION'
  | 'FAILED_PUBKEY_NOT_REGISTERED'
  | 'SKIPPED_DOMAIN_DEREGISTERED';

export interface VerificationRecord {
  event: PolicyAddressSetEvent;
  outcome: VerificationOutcome;
  action_taken: string | null;
  verified_at: string;
  brand_name_list_version: string;
}

/** A brand name list entry. */
export interface BrandNameEntry {
  name: string;
  /** Canonical domains controlled by the brand (e.g. ["nytimes.com", "nytco.com"]). */
  canonical_domains: string[];
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
  const optional = (name: string, def: string): string => process.env[name] ?? def;
  return {
    registryAddress:      required('REGISTRY_ADDRESS') as Hex,
    rpcUrl:               required('RPC_URL'),
    govPrivateKey:        required('DNS_GOV_PRIVATE_KEY') as Hex,
    ipfsGatewayUrl:       required('IPFS_GATEWAY_URL'),
    brandNameListUrl:     required('BRAND_NAME_LIST_URL'),
    eventCursorStore:     optional('EVENT_CURSOR_STORE', '/tmp/policy-verifier-cursor.json'),
    slaHours:             parseInt(optional('SLA_HOURS', '24'), 10),
    pollIntervalMs:       parseInt(optional('POLL_INTERVAL_MS', '60000'), 10),
  };
}

// ---------------------------------------------------------------------------
// Nitro scheduled task entry point
// ---------------------------------------------------------------------------

export default defineTask({
  meta: {
    name: 'poll-policy-events',
    description: 'Verify PolicyAddressSet events within 24-hour SLA',
  },
  async run() {
    const config = loadConfig();
    const publicClient = createPublicClient({ chain: arbitrum, transport: http(config.rpcUrl) });
    const govAccount = privateKeyToAccount(config.govPrivateKey);
    const govClient = createWalletClient({ account: govAccount, chain: arbitrum, transport: http(config.rpcUrl) });

    // Step 1: Load cursor.
    const cursor = await loadCursor(config.eventCursorStore);
    const latestBlock = await publicClient.getBlockNumber();

    if (cursor >= latestBlock) {
      console.log('[policy-verifier] No new blocks to process.');
      return { result: 'no-new-blocks' };
    }

    // Step 2: Fetch new PolicyAddressSet events.
    const events = await fetchPolicyAddressSetEvents(publicClient, config.registryAddress, cursor + 1n, latestBlock);
    console.log(`[policy-verifier] Found ${events.length} new PolicyAddressSet events (blocks ${cursor + 1n}–${latestBlock}).`);

    // Step 3: Load brand name list.
    const { entries: brandNames, version: brandListVersion } = await loadBrandNameList(config.brandNameListUrl);

    // Step 4: Process each event.
    const records: VerificationRecord[] = [];
    for (const event of events) {
      const record = await verifyEvent(event, publicClient, govClient, config, brandNames, brandListVersion);
      records.push(record);
      logVerificationRecord(record);
    }

    // Step 5: SLA check — alert on pending events older than SLA threshold.
    checkSlaViolations(events, config.slaHours);

    // Step 6: Advance cursor.
    await saveCursor(config.eventCursorStore, latestBlock);

    return { result: 'ok', processed: records.length };
  },
});

// ---------------------------------------------------------------------------
// Verification pipeline
// ---------------------------------------------------------------------------

async function verifyEvent(
  event: PolicyAddressSetEvent,
  publicClient: ReturnType<typeof createPublicClient>,
  govClient: ReturnType<typeof createWalletClient>,
  config: ReturnType<typeof loadConfig>,
  brandNames: BrandNameEntry[],
  brandListVersion: string,
): Promise<VerificationRecord> {
  const baseRecord = {
    event,
    verified_at: new Date().toISOString(),
    brand_name_list_version: brandListVersion,
  };

  // Step 1: Check domain registration.
  const registration = await getDomainRegistration(publicClient, config.registryAddress, event.domain);
  if (!registration.exists) {
    return { ...baseRecord, outcome: 'SKIPPED_DOMAIN_DEREGISTERED', action_taken: null };
  }

  // Step 2: Verify policy card exists.
  const policyCardExists = await cardExists(publicClient, config.registryAddress, event.policy_card_address);
  if (!policyCardExists) {
    await submitGovernanceSetPolicyAddress(govClient, config.registryAddress, event.domain, event.path, '0x' + '00'.repeat(32) as Hex);
    return { ...baseRecord, outcome: 'FAILED_POLICY_CARD_NOT_FOUND', action_taken: 'GovernanceSetPolicyAddress(zero)' };
  }

  // Step 3: Verify sub-card scope (if sub_card_address is non-zero).
  const zeroAddress = '0x' + '00'.repeat(32) as Hex;
  if (event.sub_card_address !== zeroAddress) {
    const scopeValid = await verifySubCardScope(publicClient, config.ipfsGatewayUrl, config.registryAddress, event.sub_card_address, event.path);
    if (!scopeValid) {
      await submitRemovePolicyAddress(govClient, config.registryAddress, event.domain, event.path);
      recordFraudulentPress(event.press_address, 'SCOPE_VIOLATION', event);
      return { ...baseRecord, outcome: 'FAILED_SCOPE_VIOLATION', action_taken: 'RemovePolicyAddress' };
    }
  }

  // Step 4: Brand-name scan.
  const policyCardContent = await fetchCardContent(config.ipfsGatewayUrl, publicClient, config.registryAddress, event.policy_card_address);
  const brandMatch = scanBrandNames(policyCardContent, brandNames, event.domain);
  if (brandMatch) {
    await submitRemovePolicyAddress(govClient, config.registryAddress, event.domain, event.path);
    // TODO: Check if this triggers escalation to suspension (2nd failure for this domain).
    return { ...baseRecord, outcome: 'FAILED_BRAND_NAME_IMPERSONATION', action_taken: `RemovePolicyAddress (matched: ${brandMatch})` };
  }

  // Step 5: Level 1 monitored domain — check public key registration.
  if (registration.fraudRisk === 1) {
    const keyRegistered = await checkPublicKeyRegistered(event.admin_card_address);
    if (!keyRegistered) {
      await submitRemovePolicyAddress(govClient, config.registryAddress, event.domain, event.path);
      return { ...baseRecord, outcome: 'FAILED_PUBKEY_NOT_REGISTERED', action_taken: 'RemovePolicyAddress' };
    }
  }

  return { ...baseRecord, outcome: 'VERIFIED', action_taken: null };
}

// ---------------------------------------------------------------------------
// Brand-name scanning
// ---------------------------------------------------------------------------

/**
 * Scan policy card content for registered brand names.
 * Returns the matched brand name string if found, null if no match.
 *
 * Determinism requirement: uses exact case-insensitive substring matching.
 * No discretionary judgment.
 */
function scanBrandNames(
  content: PolicyCardContent,
  brandNames: BrandNameEntry[],
  currentDomain: string,
): string | null {
  const textsToScan = [
    content.title ?? '',
    ...Object.values(content.credential_fields ?? {}).filter((v) => typeof v === 'string') as string[],
  ];

  for (const brand of brandNames) {
    // Skip if the current domain is one of the brand's canonical domains.
    if (brand.canonical_domains.some((d) => d.toLowerCase() === currentDomain.toLowerCase())) {
      continue;
    }

    for (const text of textsToScan) {
      if (text.toLowerCase().includes(brand.name.toLowerCase())) {
        return brand.name;
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Fraudulent press tracking
// ---------------------------------------------------------------------------

/** In-memory queue of fraud incidents per press address. Persisted externally in production. */
const fraudIncidents = new Map<string, Array<{ type: string; event: PolicyAddressSetEvent; timestamp: string }>>();

function recordFraudulentPress(pressAddress: Hex, violationType: string, event: PolicyAddressSetEvent): void {
  const key = pressAddress.toLowerCase();
  if (!fraudIncidents.has(key)) fraudIncidents.set(key, []);
  fraudIncidents.get(key)!.push({ type: violationType, event, timestamp: new Date().toISOString() });

  const incidents = fraudIncidents.get(key)!;
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const recentIncidents = incidents.filter((i) => i.timestamp >= thirtyDaysAgo);

  if (recentIncidents.length >= 3) {
    // TODO: Submit fraud report to PressRegistryBody's reporting channel.
    // The report should include: pressAddress, recentIncidents (with tx hashes), summary.
    console.warn(`[policy-verifier] FRAUD_REPORT_THRESHOLD: press ${pressAddress} has ${recentIncidents.length} violations in 30 days. Submit fraud report to PressRegistryBody.`);
    console.warn('[policy-verifier] Incidents:', JSON.stringify(recentIncidents, null, 2));
  }
}

// ---------------------------------------------------------------------------
// SLA monitoring
// ---------------------------------------------------------------------------

function checkSlaViolations(events: PolicyAddressSetEvent[], slaHours: number): void {
  const slaThresholdMs = slaHours * 60 * 60 * 1000;
  const now = Date.now();
  for (const event of events) {
    const observedAt = new Date(event.observed_at).getTime();
    if (now - observedAt > slaThresholdMs) {
      console.error(
        `[policy-verifier] SLA_VIOLATION: event at block ${event.block_number} for ${event.domain}/${event.path} ` +
        `has been pending for ${Math.round((now - observedAt) / 3600000)}h (SLA: ${slaHours}h). Alert operators.`
      );
      // TODO: Send webhook or PagerDuty alert.
    }
  }
}

// ---------------------------------------------------------------------------
// Cursor persistence
// ---------------------------------------------------------------------------

async function loadCursor(cursorStore: string): Promise<bigint> {
  try {
    const raw = await readFile(cursorStore, 'utf-8');
    return BigInt(JSON.parse(raw).block);
  } catch {
    return 0n;
  }
}

async function saveCursor(cursorStore: string, block: bigint): Promise<void> {
  await writeFile(cursorStore, JSON.stringify({ block: block.toString() }), 'utf-8');
}

// ---------------------------------------------------------------------------
// On-chain and IPFS helpers (stubs)
// ---------------------------------------------------------------------------

interface DomainRegistrationResult {
  exists: boolean;
  adminCardAddress: Hex;
  fraudRisk: number;
}

interface PolicyCardContent {
  title?: string;
  credential_fields?: Record<string, unknown>;
}

async function getDomainRegistration(
  _client: ReturnType<typeof createPublicClient>,
  _registryAddress: Hex,
  _domain: string,
): Promise<DomainRegistrationResult> {
  // TODO: Call getDomainEntry(keccak256(domain_bytes)) on the storage contract.
  throw new Error('TODO: implement getDomainRegistration');
}

async function cardExists(
  _client: ReturnType<typeof createPublicClient>,
  _registryAddress: Hex,
  _cardAddress: Hex,
): Promise<boolean> {
  // TODO: Call cardExists(cardAddress) on the storage contract.
  throw new Error('TODO: implement cardExists');
}

async function verifySubCardScope(
  _client: ReturnType<typeof createPublicClient>,
  _ipfsGatewayUrl: string,
  _registryAddress: Hex,
  _subCardAddress: Hex,
  _path: string,
): Promise<boolean> {
  // TODO:
  // 1. Call getSubCardEntry(subCardAddress) to get sub_card_doc_cid.
  // 2. Fetch the sub-card document from IPFS.
  // 3. Extract dns_path_scope regex from the document.
  // 4. Test regex against path. Return true if matches.
  throw new Error('TODO: implement sub-card scope verification');
}

async function fetchCardContent(
  _ipfsGatewayUrl: string,
  _client: ReturnType<typeof createPublicClient>,
  _registryAddress: Hex,
  _cardAddress: Hex,
): Promise<PolicyCardContent> {
  // TODO:
  // 1. Call getCardEntry(cardAddress) to get log_head_cid.
  // 2. Fetch card document from IPFS at log_head_cid.
  // 3. Parse and return { title, credential_fields }.
  throw new Error('TODO: implement fetchCardContent');
}

async function checkPublicKeyRegistered(_adminCardAddress: Hex): Promise<boolean> {
  // TODO: Check authority's off-chain database for the admin card's registered public key.
  // For Level 1 domains, the domain admin must have submitted their secp256r1 pubkey
  // via a side-channel HTTPS form before SetPolicyAddress submissions are accepted.
  throw new Error('TODO: implement public key registration check');
}

async function submitGovernanceSetPolicyAddress(
  _client: ReturnType<typeof createWalletClient>,
  _registryAddress: Hex,
  _domain: string,
  _path: string,
  _value: Hex,
): Promise<Hex> {
  // TODO: Construct GovernanceSetPolicyAddressPayload, sign with governance key, submit.
  throw new Error('TODO: implement GovernanceSetPolicyAddress submission');
}

async function submitRemovePolicyAddress(
  _client: ReturnType<typeof createWalletClient>,
  _registryAddress: Hex,
  _domain: string,
  _path: string,
): Promise<Hex> {
  // TODO: Construct governance RemovePolicyAddress payload, sign, submit.
  throw new Error('TODO: implement RemovePolicyAddress submission');
}

async function fetchPolicyAddressSetEvents(
  _client: ReturnType<typeof createPublicClient>,
  _registryAddress: Hex,
  _fromBlock: bigint,
  _toBlock: bigint,
): Promise<PolicyAddressSetEvent[]> {
  // TODO: Use client.getLogs() with the PolicyAddressSet event topic and the logic contract address.
  // Parse each log into a PolicyAddressSetEvent.
  // Set observed_at = new Date().toISOString() for newly-fetched events.
  throw new Error('TODO: implement event fetching');
}

async function loadBrandNameList(url: string): Promise<{ entries: BrandNameEntry[]; version: string }> {
  // TODO: Fetch the versioned brand name list JSON from the configured URL.
  // Expected format: { version: "<semver>", entries: [{ name: "...", canonical_domains: ["..."] }, ...] }
  void url;
  throw new Error('TODO: implement brand name list loading');
}

function logVerificationRecord(record: VerificationRecord): void {
  const emoji = record.outcome === 'VERIFIED' ? '✓' : '✗';
  console.log(
    `[policy-verifier] ${emoji} ${record.event.domain}/${record.event.path} ` +
    `→ ${record.outcome}` +
    (record.action_taken ? ` (action: ${record.action_taken})` : '') +
    ` [brand_list@${record.brand_name_list_version}]`
  );
}

// ---------------------------------------------------------------------------
// nitro.config.ts example
// ---------------------------------------------------------------------------
//
// import { defineNitroConfig } from 'nitropack/config';
// export default defineNitroConfig({
//   scheduledTasks: {
//     // Run every 60 seconds using a Cron-style string.
//     // On Cloudflare Workers: use a Workers Cron Trigger instead.
//     '* * * * *': 'tasks/poll-policy-events',
//   },
//   runtimeConfig: {
//     REGISTRY_ADDRESS: '',
//     RPC_URL: '',
//     DNS_GOV_PRIVATE_KEY: '',
//     IPFS_GATEWAY_URL: '',
//     BRAND_NAME_LIST_URL: '',
//     EVENT_CURSOR_STORE: '/tmp/policy-verifier-cursor.json',
//     SLA_HOURS: '24',
//     POLL_INTERVAL_MS: '60000',
//   }
// });
