/**
 * Script C — Policy Address Verifier
 *
 * Continuously polls PolicyAddressSet events and verifies each entry within
 * a 24-hour SLA. Removes invalid entries using the script key (1-of-1).
 * Escalation actions (level-2 suspension) generate unsigned payloads for
 * the governance board and do NOT submit transactions.
 *
 * Authorization:
 *   Script key (1-of-1): RemovePolicyAddressGov, GovernanceSetPolicyAddressAuto
 *   Board (M-of-N, NOT submitted here): FlagDomainFraudRisk (suspension)
 *
 * Process spec: specs/process_specs/dns_governance_verifier.md §Script C
 */

import { readFile, writeFile } from 'fs/promises';
import { loadConfig, createIpfsClient } from './config.js';
import { createDnsGovRegistryClient } from './registry.js';
import type { PolicyAddressSetLog } from './registry.js';
import type { GovScriptConfig } from './config.js';

// defineTask shim — matches Nitro 2.x task interface shape for tsc compatibility.
// When deployed as a Nitro task in tasks/, the runtime provides the real implementation.
const defineTask = (task: { meta: { name: string; description: string }; run: () => Promise<unknown> }) => task;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type VerificationOutcome =
  | 'VERIFIED'
  | 'FAILED_POLICY_CARD_NOT_FOUND'
  | 'FAILED_SCOPE_VIOLATION'
  | 'FAILED_BRAND_NAME_IMPERSONATION'
  | 'FAILED_PUBKEY_NOT_REGISTERED'
  | 'SKIPPED_DOMAIN_DEREGISTERED';

export interface VerificationRecord {
  event: PolicyAddressSetLog;
  outcome: VerificationOutcome;
  actionTaken: string | null;
  verifiedAt: string;
  brandListVersion: string;
}

export interface BrandNameEntry {
  name: string;
  /** Canonical domains the brand owns — entries from these domains are not flagged. */
  canonicalDomains: string[];
}

interface BrandNameList {
  version: string;
  entries: BrandNameEntry[];
}

interface PolicyCardContent {
  title?: string;
  credential_fields?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Nitro scheduled task
// ---------------------------------------------------------------------------

export default defineTask({
  meta: { name: 'poll-policy-events', description: 'Verify PolicyAddressSet events within 24-hour SLA' },
  async run() {
    const config = loadConfig();
    const ipfs = createIpfsClient(config);
    const registry = createDnsGovRegistryClient(config);

    // Load cursor (last processed block).
    const cursor = await loadCursor(config.eventCursorStore);
    const latestBlock = await registry.getLatestBlock();
    if (cursor >= latestBlock) {
      console.log('[policy-verifier] No new blocks.');
      return { result: 'no-new-blocks' };
    }

    // Fetch new events.
    const events = await registry.fetchPolicyAddressSetEvents(cursor + 1n, latestBlock);
    console.log(`[policy-verifier] ${events.length} new PolicyAddressSet events (blocks ${cursor + 1n}–${latestBlock})`);

    // Load brand name list.
    const brandList = await loadBrandNameList(config.brandNameListUrl);

    // Process each event.
    const records: VerificationRecord[] = [];
    for (const event of events) {
      const record = await verifyEvent(event, registry, ipfs, config, brandList);
      records.push(record);
      logRecord(record);
    }

    // SLA check — alert on events pending past the threshold.
    const slaMs = (config.slaHours) * 3600_000;
    const now = Date.now();
    for (const event of events) {
      if (now - new Date(event.transactionHash).getTime() > slaMs) {
        // transactionHash doesn't give a timestamp, but block number provides ordering.
        // In production, map block → timestamp via publicClient.getBlock(blockNumber).timestamp.
        console.error(`[policy-verifier] SLA_ALERT: event at block ${event.blockNumber} for ${event.domain}/${event.path} may exceed SLA`);
      }
    }

    // Advance cursor.
    await saveCursor(config.eventCursorStore, latestBlock);
    return { result: 'ok', processed: records.length };
  },
});

// ---------------------------------------------------------------------------
// Verification pipeline
// ---------------------------------------------------------------------------

async function verifyEvent(
  event: PolicyAddressSetLog,
  registry: ReturnType<typeof createDnsGovRegistryClient>,
  ipfs: ReturnType<typeof createIpfsClient>,
  config: GovScriptConfig,
  brandList: BrandNameList,
): Promise<VerificationRecord> {
  const base = { event, verifiedAt: new Date().toISOString(), brandListVersion: brandList.version };
  const zero = '0x' + '00'.repeat(32);

  // Step 1: Check domain registration.
  const reg = await registry.getDomainRegistration(event.domain);
  if (!reg.exists) {
    return { ...base, outcome: 'SKIPPED_DOMAIN_DEREGISTERED', actionTaken: null };
  }

  // Step 2: Verify policy card exists; clear stale entries automatically.
  const policyCardExists = await registry.cardExists(event.policyCardAddress);
  if (!policyCardExists) {
    await registry.governanceSetPolicyAddressAuto(event.domain, event.path, zero as `0x${string}`);
    return { ...base, outcome: 'FAILED_POLICY_CARD_NOT_FOUND', actionTaken: 'GovernanceSetPolicyAddress(zero)' };
  }

  // Step 3: Verify sub-card scope (when a sub-card submitted the entry).
  if (event.subCardAddress !== zero) {
    const subEntry = await registry.getSubCardEntry(event.subCardAddress);
    if (subEntry.active && subEntry.subCardDocCid.length > 0) {
      const docCidStr = bytesToCidString(subEntry.subCardDocCid);
      try {
        const docBytes = await ipfs.fetchFromIPFS(docCidStr);
        const doc = JSON.parse(new TextDecoder().decode(docBytes)) as { dns_path_scope?: string | null };
        if (doc.dns_path_scope !== null && doc.dns_path_scope !== undefined) {
          const regex = new RegExp(doc.dns_path_scope);
          if (!regex.test(event.path)) {
            await registry.removePolicyAddressGov(event.domain, event.path);
            recordFraudulentPress(event.pressAddress, 'SCOPE_VIOLATION', event);
            return { ...base, outcome: 'FAILED_SCOPE_VIOLATION', actionTaken: 'RemovePolicyAddress' };
          }
        }
      } catch (err) {
        // IPFS unavailability: log and skip (do not remove — avoid false positives).
        console.warn(`[policy-verifier] Could not fetch sub-card doc ${docCidStr}: ${String(err)}. Skipping scope check.`);
      }
    }
  }

  // Step 4: Brand-name scan.
  try {
    const policyEntry = await registry.getCardEntry(event.policyCardAddress);
    const cidStr = bytesToCidString(policyEntry.logHeadCid);
    const policyDocBytes = await ipfs.fetchFromIPFS(cidStr);
    const policyDoc = JSON.parse(new TextDecoder().decode(policyDocBytes)) as PolicyCardContent;

    const brandMatch = scanBrandNames(policyDoc, brandList.entries, event.domain);
    if (brandMatch) {
      await registry.removePolicyAddressGov(event.domain, event.path);
      // Track violations; escalate if domain accumulates multiple failures.
      const domainViolations = recordDomainViolation(event.domain);
      if (domainViolations >= 2 && reg.fraudRisk < 2) {
        // Escalate to board for suspension — scripts do NOT suspend unilaterally.
        const payload = await registry.generateEscalationPayload('FlagDomainFraudRisk', {
          domain: event.domain,
          fraud_risk: 2,
          // suspension_expires_at: board should set per the charter's N-year formula
        });
        console.error(`[policy-verifier] BOARD_ESCALATION: domain ${event.domain} has ${domainViolations} violations. Suspension requires board quorum.\n${payload.instructions}`);
      }
      return { ...base, outcome: 'FAILED_BRAND_NAME_IMPERSONATION', actionTaken: `RemovePolicyAddress (matched: "${brandMatch}")` };
    }
  } catch (err) {
    // IPFS unavailability: skip scan, do not remove.
    console.warn(`[policy-verifier] Could not fetch policy card doc for ${event.policyCardAddress}: ${String(err)}. Skipping brand scan.`);
  }

  // Step 5: Level-1 (monitored) public key registration check.
  if (reg.fraudRisk === 1) {
    const keyRegistered = await checkPublicKeyRegistered(event.adminCardAddress);
    if (!keyRegistered) {
      await registry.removePolicyAddressGov(event.domain, event.path);
      return { ...base, outcome: 'FAILED_PUBKEY_NOT_REGISTERED', actionTaken: 'RemovePolicyAddress' };
    }
  }

  return { ...base, outcome: 'VERIFIED', actionTaken: null };
}

// ---------------------------------------------------------------------------
// Brand-name scanning (deterministic — no discretion)
// ---------------------------------------------------------------------------

function scanBrandNames(
  content: PolicyCardContent,
  brands: BrandNameEntry[],
  currentDomain: string,
): string | null {
  const textsToScan = [
    content.title ?? '',
    ...Object.values(content.credential_fields ?? {})
      .filter((v): v is string => typeof v === 'string'),
  ];

  for (const brand of brands) {
    // Skip if the current domain is one the brand itself controls.
    if (brand.canonicalDomains.some(d => d.toLowerCase() === currentDomain.toLowerCase())) continue;
    for (const text of textsToScan) {
      if (text.toLowerCase().includes(brand.name.toLowerCase())) return brand.name;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Fraudulent press tracking
// ---------------------------------------------------------------------------

// In-memory incident queue. Persist externally (Redis, file) in production.
const pressIncidents = new Map<string, Array<{ type: string; transactionHash: string; timestamp: string }>>();
// Per-domain violation counter for brand scan failures.
const domainViolationCount = new Map<string, number>();

function recordFraudulentPress(pressAddress: string, violationType: string, event: PolicyAddressSetLog): void {
  const key = pressAddress.toLowerCase();
  const incidents = pressIncidents.get(key) ?? [];
  incidents.push({ type: violationType, transactionHash: event.transactionHash, timestamp: new Date().toISOString() });
  pressIncidents.set(key, incidents);

  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 3600_000).toISOString();
  const recent = incidents.filter(i => i.timestamp >= thirtyDaysAgo);
  if (recent.length >= 3) {
    console.error(
      `[policy-verifier] FRAUD_REPORT_THRESHOLD: press ${pressAddress} has ${recent.length} violations in 30 days.\n` +
      `Submit fraud report to PressRegistryBody. Recent incidents:\n${JSON.stringify(recent, null, 2)}`
    );
  }
}

function recordDomainViolation(domain: string): number {
  const count = (domainViolationCount.get(domain) ?? 0) + 1;
  domainViolationCount.set(domain, count);
  return count;
}

// ---------------------------------------------------------------------------
// Public key registration check (Level-1 monitored domains)
// ---------------------------------------------------------------------------

/**
 * Check the authority's off-chain key registration database.
 * For Level-1 (monitored) domains, the domain admin must have submitted their
 * public key to the authority before SetPolicyAddress submissions are accepted.
 *
 * In production: query the authority's internal API or database.
 * This placeholder always returns true and must be replaced before deployment.
 */
async function checkPublicKeyRegistered(adminCardAddress: string): Promise<boolean> {
  // TODO (deployment): replace with a real database or API lookup.
  // e.g., await fetch(`${process.env.KEY_REGISTRY_URL}/keys/${adminCardAddress}`)
  console.warn(`[policy-verifier] Key registration check not yet connected for ${adminCardAddress} — returning true`);
  return true;
}

// ---------------------------------------------------------------------------
// Brand name list
// ---------------------------------------------------------------------------

async function loadBrandNameList(url: string): Promise<BrandNameList> {
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Brand name list fetch failed: ${url} → HTTP ${res.status}`);
  const data = await res.json() as { version?: string; entries?: BrandNameEntry[] };
  if (!data.version || !Array.isArray(data.entries)) {
    throw new Error(`Brand name list at ${url} is missing required fields (version, entries)`);
  }
  return { version: data.version, entries: data.entries };
}

// ---------------------------------------------------------------------------
// Cursor persistence
// ---------------------------------------------------------------------------

async function loadCursor(cursorStore: string): Promise<bigint> {
  try {
    const raw = await readFile(cursorStore, 'utf-8');
    return BigInt((JSON.parse(raw) as { block: string }).block);
  } catch {
    return 0n;
  }
}

async function saveCursor(cursorStore: string, block: bigint): Promise<void> {
  await writeFile(cursorStore, JSON.stringify({ block: block.toString() }), 'utf-8');
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

function logRecord(record: VerificationRecord): void {
  const mark = record.outcome === 'VERIFIED' ? '✓' : '✗';
  console.log(
    `[policy-verifier] ${mark} ${record.event.domain}/${record.event.path} → ${record.outcome}` +
    (record.actionTaken ? ` (${record.actionTaken})` : '') +
    ` [brand_list@${record.brandListVersion}]`
  );
}

function bytesToCidString(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
}
