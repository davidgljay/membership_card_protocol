/**
 * `specs/process_specs/dns_governance_verifier.md` — Phase 5 Wave 3.
 *
 * This spec documents three Nitro server scripts (governance/scripts/
 * txt-verification.ts, register-domain.ts, admin-deactivation.ts,
 * policy-address-verifier.ts). None of them run as a live HTTP/scheduled
 * service anywhere in this stack — `docker-compose.yml` has zero references
 * to "governance", and both `defineEventHandler` (A1) and `defineTask` (C)
 * need a Nitro runtime this stack doesn't wire up. Building and deploying a
 * new Nitro service is out of scope for a test-writing pass.
 *
 * What IS directly testable: the on-chain mechanics these scripts drive —
 * `RegisterDomain` (A2), `DeregisterDomain` (B), and reading
 * `PolicyAddressSet` events (Script C's verification target) — against the
 * real local nitro-devnode chain, the same way
 * `fixtures/src/governanceBootstrap.ts` already proves `RegisterPolicy`/
 * `AuthorizePress` work via direct contract calls rather than through any
 * HTTP layer.
 *
 * ── Real bug found this pass (escalated in the suite's own report, not
 * fixed here — out of scope for a test-writing pass) ──────────────────────
 * `governance/scripts/registry.ts`'s `LOGIC_ABI` is unusable against the
 * real deployed contract:
 *   1. It declares PascalCase function names (`RegisterDomain`,
 *      `DeregisterDomain`, `GetDomainRegistration`, `CardExists`, ...).
 *      Stylus SDK 0.8 dispatches camelCase (`registerDomain`,
 *      `deregisterDomain`, ...) — confirmed against `press/src/chain/
 *      registry.ts`'s own (working, in-production) camelCase ABI and
 *      against `cargo stylus export-abi`'s ground-truth output for this
 *      exact logic contract (run during this suite's development).
 *   2. It types `Vec<u8>`/`Vec<Vec<u8>>` parameters as Solidity `bytes`/
 *      `bytes[]`. Stylus SDK 0.8 maps these to `uint8[]`/`uint8[][]`
 *      instead (again confirmed via `cargo stylus export-abi`) — a stale
 *      code comment in `contracts/logic-contract/src/lib.rs` (line ~1094,
 *      "Vec<u8> ... maps to Solidity `bytes`") appears to be the source of
 *      this same misconception; it should probably be corrected too.
 * Every write method on `createDnsGovRegistryClient` (registerDomain,
 * deregisterDomain, removePolicyAddressGov, clearDomainEntries,
 * governanceSetPolicyAddressAuto) and most read methods would therefore
 * either encode a call to a non-existent selector (revert) or mis-decode
 * the response. The one exception: `fetchPolicyAddressSetEvents` uses a raw
 * `getLogs` event filter built from `PolicyAddressSet`'s Solidity `event`
 * definition (a *different* code path — `alloy_sol_types::sol!` macro
 * events, not Stylus SDK method dispatch), which matches the real event
 * shape correctly.
 *
 * Because of this, and because `governance/scripts` isn't a workspace
 * dependency of `suites/package.json` (adding one for a single suite is out
 * of this pass's scope), this suite defines its own minimal, ABI-verified
 * `LOGIC_ABI` for the calls it needs, and builds/signs DnsGovernanceBody
 * (body_id=2) governance payloads via the same tested Rust binaries
 * `fixtures/src/governanceBootstrap.ts` already uses
 * (`contracts/scripts/build_governance_payload.rs` / `sign_payload.rs`,
 * which already support `register_domain` / `deregister_domain` /
 * `set_dns_governance_policy_address` ops) rather than hand-rolling a
 * second, independently-risky canonicalization/signing path.
 *
 * Requires the `integration_tests` stack up (`docker compose up -d --wait`)
 * and `contracts/deployments/local.json` to exist.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createPublicClient,
  createWalletClient,
  http,
  parseAbi,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { arbitrumSepolia } from 'viem/chains';
import { p256 } from '@noble/curves/p256';
import { keccak_256 } from '@noble/hashes/sha3';
import {
  pinJsonToKubo,
  ensureGovernanceBootstrap,
  mintCard,
  deriveKeypair,
  type GovernanceKeypair,
} from '@membership-card-protocol/integration-fixtures';
import { keccak256 as appSdkKeccak256 } from '@membership-card-protocol/app-sdk';
import { PRESS_BASE_URL, KUBO_API_URL, ARBITRUM_RPC_URL } from '../support/liveCard.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const CONTRACTS_SCRIPTS_DIR = join(REPO_ROOT, 'contracts/scripts');

// ── Ground-truth ABI (verified against `cargo stylus export-abi` for the
//    logic contract, and cross-checked against press/src/chain/registry.ts's
//    own working camelCase ABI) — see doc comment above for why this suite
//    doesn't reuse governance/scripts/registry.ts's (broken) ABI. ─────────
const LOGIC_ABI = parseAbi([
  'function registerDomain(uint8[] domain, bytes32 admin_card_address, uint8[] admin_secp256r1_key, uint8[] governance_payload, uint8[][] governance_sigs) external',
  'function deregisterDomain(uint8[] domain, uint8[] governance_payload, uint8[][] governance_sigs) external',
  'function setDnsGovernancePolicyAddress(bytes32 new_policy_address, uint8[] governance_payload, uint8[][] governance_sigs) external',
  'function setPolicyAddress(uint8[] domain, uint8[] path, bytes32 policy_card_address, bytes32 admin_card_address, bytes32 sub_card_address, bytes32 press_address, uint8[] press_sig_payload, uint8[] press_signature) external',
  'function getDomainRegistration(uint8[] domain) external view returns (bytes32, uint64, uint8, uint64, bool)',
  'function getDnsGovernancePolicyAddress() external view returns (bytes32)',
  'function getDnsAdminCardKey(bytes32 card_address) external view returns (uint8[])',
  // Multi-return values that mix uint8[] with other fields decode as an
  // extra 32-byte outer tuple offset under Stylus SDK 0.8 (see
  // project_stylus_abi.md memory / getCardEntry precedent) — declaring the
  // return as a named struct makes viem expect that offset correctly.
  'struct GovKeyset { uint8[] keys; uint8 key_count; uint8 quorum; uint32 version; uint8 key_scheme; }',
  'function getGovernanceKeyset(uint8 body_id) external view returns (GovKeyset r)',
  'struct PressAuth { uint8[] press_pubkey; bytes32 mldsa44_key_hash; uint8 key_scheme; bool active; uint64 next_sequence; uint64 authorized_at; uint64 revoked_at; }',
  'function getPressAuthorization(bytes32 policy_address, bytes32 press_address) external view returns (PressAuth r)',
  'function cardExists(bytes32 card_address) external view returns (bool)',
]);

const DNS_GOVERNANCE_BODY = 2;

// Same prefunded nitro-devnode `--dev` account `fixtures/src/
// governanceBootstrap.ts` uses to pay gas — carries no governance authority
// of its own, only funds transactions.
const DEV_GAS_PRIVATE_KEY = '0xb6b15c8cb491557369f3c7d2c287b053eb229daa9c22138887752191c9520659' as Hex;

function normalizeHexKey(key: string): Hex {
  return (key.startsWith('0x') ? key : `0x${key}`) as Hex;
}

function hexToBytesArg(hex: string): number[] {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return Array.from(bytes);
}

function utf8BytesArg(s: string): number[] {
  return Array.from(new TextEncoder().encode(s));
}

/** Build a canonical governance-payload JSON string via the tested Rust binary (see doc comment). */
function buildGovernancePayload(args: string[]): string {
  return execFileSync(
    'cargo',
    ['run', '--manifest-path', `${CONTRACTS_SCRIPTS_DIR}/Cargo.toml`, '--bin', 'build_governance_payload', '--quiet', '--', ...args],
    { encoding: 'utf-8' }
  ).trim();
}

/** Sign a payload with a secp256r1 private key via the tested Rust binary (see doc comment). */
function signPayload(privateKeyHex: string, payload: string): string {
  return execFileSync(
    'cargo',
    ['run', '--manifest-path', `${CONTRACTS_SCRIPTS_DIR}/Cargo.toml`, '--bin', 'sign_payload', '--quiet', '--', '--key-hex', normalizeHexKey(privateKeyHex), '--payload', payload],
    { encoding: 'utf-8' }
  ).trim();
}

// ── Minimal press write-gate payload signing (mirrors press/src/chain/
//    registry.ts's own buildAndSignPayload — no canonical-form Rust binary
//    exists for *press* payloads, only governance ones, so this follows the
//    same in-repo TS pattern press itself already uses in production). Only
//    "op" and "sequence" fields are extracted on-chain (payload_parser is
//    substring-based — see contracts/protocol-types/src/lib.rs), so exact
//    field content/order beyond those two doesn't need to match anything. ──
function canonicalizeSimple(obj: Record<string, unknown>): Uint8Array {
  function ser(v: unknown): string {
    if (v === null) return 'null';
    if (typeof v === 'boolean') return String(v);
    if (typeof v === 'number') return JSON.stringify(v);
    if (typeof v === 'string') return JSON.stringify(v);
    if (Array.isArray(v)) return `[${v.map(ser).join(',')}]`;
    if (typeof v === 'object') {
      const keys = Object.keys(v as object).sort();
      return `{${keys.map((k) => `${JSON.stringify(k)}:${ser((v as Record<string, unknown>)[k])}`).join(',')}}`;
    }
    throw new TypeError(`Cannot serialize ${typeof v}`);
  }
  return new TextEncoder().encode(ser(obj));
}

function secp256r1SignRaw(privateKeyHex: string, messageHash: Uint8Array): Uint8Array {
  const priv = new Uint8Array(hexToBytesArg(normalizeHexKey(privateKeyHex)));
  return p256.sign(messageHash, priv, { lowS: true, prehash: false }).toCompactRawBytes();
}

function p256PublicKeyXY(privateKeyHex: string): Uint8Array {
  const raw = new Uint8Array(hexToBytesArg(normalizeHexKey(privateKeyHex)));
  return p256.getPublicKey(raw, false).slice(1); // drop 0x04 prefix -> 64 bytes x||y
}

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

describe('dns_governance_verifier.md (live stack)', () => {
  const deploymentFile = join(REPO_ROOT, 'contracts/deployments/local.json');
  const deployment = JSON.parse(readFileSync(deploymentFile, 'utf-8')) as {
    contracts: { logic_contract: string; storage_contract: string };
    dev_governance_keypair: GovernanceKeypair;
  };
  const logicAddress = deployment.contracts.logic_contract as Hex;
  const devGovernanceKeypair = deployment.dev_governance_keypair;

  const publicClient = createPublicClient({ chain: arbitrumSepolia, transport: http(ARBITRUM_RPC_URL) });
  const gasWalletClient = createWalletClient({
    account: privateKeyToAccount(DEV_GAS_PRIVATE_KEY),
    chain: arbitrumSepolia,
    transport: http(ARBITRUM_RPC_URL),
  });

  let dnsPolicyAddress: Hex;
  let pressAddress: Hex;
  let pressSecp256r1PrivateKey: string;
  let adminCardAddress: Hex;
  let adminSecpPubkeyXY: Uint8Array;
  let dnsGovVersion: number;
  const domain = `dns-gov-test-${Date.now()}.example`;

  async function readGovVersion(): Promise<number> {
    const result = (await publicClient.readContract({
      address: logicAddress,
      abi: LOGIC_ABI,
      functionName: 'getGovernanceKeyset',
      args: [DNS_GOVERNANCE_BODY],
    })) as { version: number };
    return result.version;
  }

  async function submitDnsGovTx(functionName: 'registerDomain' | 'deregisterDomain' | 'setDnsGovernancePolicyAddress', args: unknown[]): Promise<Hex> {
    const hash = await gasWalletClient.writeContract({
      address: logicAddress,
      abi: LOGIC_ABI,
      functionName,
      args: args as never,
      account: gasWalletClient.account!,
      chain: arbitrumSepolia,
    });
    await publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 });
    return hash;
  }

  beforeAll(async () => {
    // ── Fresh DnsGovernancePolicyAddress-eligible policy, distinct from the
    // shared fixtures policy (per this suite's own Fix #36 scope note: DNS
    // governance uses its own policy address, not the shared permissive
    // one). Sequential with everything else in this file — see
    // vitest.config.ts's fileParallelism:false and suites/README.md. ──────
    const pressInfo = (await (await fetch(`${PRESS_BASE_URL}/api/press`)).json()) as {
      press_card_cid: string;
      gas_address: string;
    };
    pressAddress = pressInfo.gas_address as Hex;

    const policyDoc = {
      policy_id: 'dns-gov-policy-' + Date.now(),
      field_definitions: { display_name: { type: 'string', required: false } },
      approved_presses: [pressInfo.press_card_cid],
    };
    const dnsPolicyId = await pinJsonToKubo(KUBO_API_URL, policyDoc);
    dnsPolicyAddress = ('0x' + appSdkKeccak256(new TextEncoder().encode(dnsPolicyId))) as Hex;

    const pressDevVars = parseDevVars(join(REPO_ROOT, 'integration_tests/env/press/.dev.vars'));
    pressSecp256r1PrivateKey = pressDevVars.PRESS_SECP256R1_PRIVATE_KEY!;
    const { base64UrlToBytes } = await import('@membership-card-protocol/app-sdk');
    const pressMlDsa44PrivateKey = base64UrlToBytes(pressDevVars.PRESS_MLDSA44_PRIVATE_KEY!);

    // RegisterPolicy (RootPolicyBody) + AuthorizePress (PressRegistryBody) for
    // this new DNS-governance-scoped policy — same dev_governance_keypair
    // that already governs the shared fixtures policy (genesis-seeded 1-of-1
    // for all three governance bodies; see governanceBootstrap.ts's own doc
    // comment and storage-contract's initialize()).
    await ensureGovernanceBootstrap({
      rpcUrl: ARBITRUM_RPC_URL,
      logicAddress,
      storageAddress: deployment.contracts.storage_contract as Hex,
      policyAddress: dnsPolicyAddress,
      pressAddress,
      pressSecp256r1PrivateKey,
      pressMlDsa44PrivateKey,
      governanceKeypair: devGovernanceKeypair,
      pressGasWalletPrivateKey: pressDevVars.PRESS_GAS_WALLET_PRIVATE_KEY!,
      contractsScriptsDir: CONTRACTS_SCRIPTS_DIR,
    });

    // ── Point DnsGovernancePolicyAddress at our fresh policy. Always a
    // genuinely new value (timestamp-derived dnsPolicyAddress), so the
    // on-chain no-op guard (E-43: new != current) never blocks this,
    // including on a second consecutive run of this suite. This *does*
    // orphan any domain admin cards registered under a previously-set
    // DnsGovernancePolicyAddress (per dns_ops.rs's own doc comment on
    // SetDnsGovernancePolicyAddress) — safe here since this is the only
    // suite in this stack exercising DNS governance at all. ──────────────
    dnsGovVersion = await readGovVersion();
    {
      const payload = buildGovernancePayload(['--op', 'set_dns_governance_policy_address', '--version', String(dnsGovVersion), '--address', dnsPolicyAddress]);
      const sigHex = signPayload(devGovernanceKeypair.private_key, payload);
      await submitDnsGovTx('setDnsGovernancePolicyAddress', [dnsPolicyAddress, utf8BytesArg(payload), [hexToBytesArg(sigHex)]]);
    }

    // ── Mint the domain admin card under the DNS governance policy (Stage
    // A1's "issue domain admin card" step, minus the DNS TXT check itself —
    // see the suite's it.todo for why real DNS resolution is out of reach).
    const label = `dns-admin-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    await mintCard({ pressBaseUrl: PRESS_BASE_URL, policyId: dnsPolicyId, label, fieldValues: { display_name: 'DNS Admin Test Card' } });
    const holderKeypair = deriveKeypair(`holder:${label}`);
    adminCardAddress = ('0x' + appSdkKeccak256(holderKeypair.publicKey)) as Hex;

    // Fresh secp256r1 keypair standing in for the applicant's key (A1's
    // `secp256r1_pubkey` field, carried forward to A2/RegisterDomain per
    // Fix #33's cross-reference).
    const adminSecpPrivKey = p256.utils.randomPrivateKey();
    adminSecpPubkeyXY = p256.getPublicKey(adminSecpPrivKey, false).slice(1);
  }, 120_000);

  it('Bootstrap precondition: DnsGovernancePolicyAddress is initialized and the admin card exists under it (A1 preconditions)', async () => {
    const onChainDnsPolicy = await publicClient.readContract({
      address: logicAddress,
      abi: LOGIC_ABI,
      functionName: 'getDnsGovernancePolicyAddress',
    });
    expect((onChainDnsPolicy as string).toLowerCase()).toBe(dnsPolicyAddress.toLowerCase());

    const exists = await publicClient.readContract({
      address: logicAddress,
      abi: LOGIC_ABI,
      functionName: 'cardExists',
      args: [adminCardAddress],
    });
    expect(exists).toBe(true);
  });

  it('Stage A2 (RegisterDomain, registry_contract.md §4.17): registers a domain admin card on-chain', async () => {
    const payload = buildGovernancePayload([
      '--op', 'register_domain',
      '--version', String(dnsGovVersion),
      '--policy', domain, // build_governance_payload.rs maps --policy -> domain for this op
      '--press', adminCardAddress, // --press -> admin_card_address
      '--press-pubkey', '0x' + Buffer.from(adminSecpPubkeyXY).toString('hex'), // --press-pubkey -> admin_secp256r1_key
    ]);
    const sigHex = signPayload(devGovernanceKeypair.private_key, payload);

    await submitDnsGovTx('registerDomain', [
      utf8BytesArg(domain),
      adminCardAddress,
      Array.from(adminSecpPubkeyXY),
      utf8BytesArg(payload),
      [hexToBytesArg(sigHex)],
    ]);

    const [admin, , fraudRisk, , exists] = (await publicClient.readContract({
      address: logicAddress,
      abi: LOGIC_ABI,
      functionName: 'getDomainRegistration',
      args: [utf8BytesArg(domain)],
    })) as unknown as [Hex, bigint, number, bigint, boolean];

    expect(admin.toLowerCase()).toBe(adminCardAddress.toLowerCase());
    expect(exists).toBe(true);
    expect(fraudRisk).toBe(0);

    // Fix #33 cross-reference: RegisterDomain writes the admin's
    // secp256r1 key to DnsAdminCardKeys.
    const storedKey = (await publicClient.readContract({
      address: logicAddress,
      abi: LOGIC_ABI,
      functionName: 'getDnsAdminCardKey',
      args: [adminCardAddress],
    })) as unknown as readonly number[];
    expect(Uint8Array.from(storedKey)).toEqual(adminSecpPubkeyXY);
  });

  it('Script C target (PolicyAddressSet, registry_contract.md §4.19): a real SetPolicyAddress write emits a decodable on-chain event', async () => {
    // This is the event Script C polls for (policy-address-verifier.ts's
    // "Polling PolicyAddressSet on-chain events"). None of A1/A2/B/C
    // themselves call SetPolicyAddress — it's a press-authorized write
    // (registry_contract.md §4.19, run_write_gate against
    // DnsGovernancePolicyAddress) invoked by a *different* flow
    // (press.md §5.4's sub-card delegation path). To exercise Script C's
    // actual read target for real rather than asserting against an
    // always-empty getLogs() call, this test performs one real
    // press-signed SetPolicyAddress write directly (mirroring press/src/
    // chain/registry.ts's own buildAndSignPayload pattern — see this
    // file's header comment) using an already-minted, already-on-chain
    // card as a stand-in policy_card_address (SetPolicyAddress only
    // requires CardExists, not any particular policy).
    const path = 'staff/reporter';
    const policyCardAddress = adminCardAddress; // any card that CardExists() — reuse the admin card itself

    const { next_sequence: nextSequence } = (await publicClient.readContract({
      address: logicAddress,
      abi: LOGIC_ABI,
      functionName: 'getPressAuthorization',
      args: [dnsPolicyAddress, pressAddress],
    })) as { next_sequence: bigint };

    const pressPayload = {
      op: 'set_policy_address',
      domain,
      path,
      sequence: Number(nextSequence),
      timestamp: new Date().toISOString(),
    };
    const payloadBytes = canonicalizeSimple(pressPayload);
    const msgHash = keccak_256(payloadBytes);
    const pressSignature = secp256r1SignRaw(pressSecp256r1PrivateKey, msgHash);

    const zero32 = ('0x' + '00'.repeat(32)) as Hex;
    const setPolicyHash = await gasWalletClient.writeContract({
      address: logicAddress,
      abi: LOGIC_ABI,
      functionName: 'setPolicyAddress',
      args: [
        utf8BytesArg(domain),
        utf8BytesArg(path),
        policyCardAddress,
        adminCardAddress,
        zero32, // sub_card_address = zero (no sub-card delegation in this test)
        pressAddress,
        Array.from(payloadBytes),
        Array.from(pressSignature),
      ],
      account: gasWalletClient.account!,
      chain: arbitrumSepolia,
    });
    const setPolicyReceipt = await publicClient.waitForTransactionReceipt({ hash: setPolicyHash, timeout: 120_000 });
    if (setPolicyReceipt.status !== 'success') {
      throw new Error(`setPolicyAddress tx reverted: ${setPolicyHash}`);
    }

    // fromBlock/toBlock are pinned to the tx's own receipt rather than
    // separate pre/post `getBlockNumber()` snapshots: viem's public client
    // caches `eth_blockNumber` for `cacheTime` (default = pollingInterval,
    // 4s), and this local chain mines far faster than that — two
    // back-to-back `getBlockNumber()` calls bracketing the tx could both
    // return the same cached pre-tx value and silently exclude the block
    // the event was actually emitted in.
    const logs = await publicClient.getLogs({
      address: logicAddress,
      event: {
        type: 'event',
        name: 'PolicyAddressSet',
        inputs: [
          { type: 'bytes', name: 'domain', indexed: false },
          { type: 'bytes', name: 'path', indexed: false },
          { type: 'bytes32', name: 'policy_card_address', indexed: true },
          { type: 'bytes32', name: 'admin_card_address', indexed: false },
          { type: 'bytes32', name: 'sub_card_address', indexed: false },
          { type: 'bytes32', name: 'press_address', indexed: false },
          { type: 'uint64', name: 'timestamp', indexed: false },
        ],
      },
      fromBlock: setPolicyReceipt.blockNumber,
      toBlock: setPolicyReceipt.blockNumber,
    });

    const hexToUtf8 = (hex: string): string => Buffer.from(hex.replace(/^0x/, ''), 'hex').toString('utf-8');
    const match = logs.find((l) => hexToUtf8(l.args.domain as unknown as string) === domain);
    expect(match).toBeDefined();
    expect(hexToUtf8(match!.args.path as unknown as string)).toBe(path);
    expect((match!.args.admin_card_address as string).toLowerCase()).toBe(adminCardAddress.toLowerCase());
    expect((match!.args.press_address as string).toLowerCase()).toBe(pressAddress.toLowerCase());

    // Verification Pipeline step 1 (spec): GetDomainRegistration still
    // exists at this point (domain not yet deregistered) — the "skip,
    // domain deregistered" branch is exercised by the DeregisterDomain
    // test below running afterward and leaving the domain's PolicyAddresses
    // entry orphaned (spec's documented, expected post-DeregisterDomain
    // state — ClearDomainEntries, not DeregisterDomain, clears entries).
  });

  it('Script B (DeregisterDomain, registry_contract.md §4.18): clears the domain admin pointer and the admin secp256r1 key', async () => {
    const payload = buildGovernancePayload([
      '--op', 'deregister_domain',
      '--version', String(dnsGovVersion),
      '--policy', domain,
    ]);
    const sigHex = signPayload(devGovernanceKeypair.private_key, payload);

    await submitDnsGovTx('deregisterDomain', [utf8BytesArg(domain), utf8BytesArg(payload), [hexToBytesArg(sigHex)]]);

    const [admin, , , , exists] = (await publicClient.readContract({
      address: logicAddress,
      abi: LOGIC_ABI,
      functionName: 'getDomainRegistration',
      args: [utf8BytesArg(domain)],
    })) as unknown as [Hex, bigint, number, bigint, boolean];

    expect(admin).toBe('0x' + '00'.repeat(32));
    expect(exists).toBe(true); // write-once invariant: exists is preserved

    const clearedKey = (await publicClient.readContract({
      address: logicAddress,
      abi: LOGIC_ABI,
      functionName: 'getDnsAdminCardKey',
      args: [adminCardAddress],
    })) as unknown as readonly number[];
    expect(clearedKey.length).toBe(0);
  });

  // ── Genuinely out of reach in this environment (see file header) ────────

  it.todo(
    'Stage A1 (txt-verification.ts): real DNS TXT record resolution at _mcard.<domain> — ' +
      'requires a domain we actually control and can publish a TXT record for; not achievable ' +
      'in this environment. Also flagging as a testability gap independent of this suite: ' +
      "resolveTxtWithRetry (governance/scripts/txt-verification.ts) hardcodes `new (await import('dns')).Resolver()` " +
      'with no injectable resolver parameter, so even a mocked-DNS unit test would need module-level ' +
      'monkeypatching of the node:dns import rather than a clean dependency-injection seam.'
  );

  it.todo(
    'Script A1/A2/B as running Nitro HTTP handlers: request validation (HTTP 400), the 422 ' +
      '(txt_record_not_found), 403 (admin mismatch / bad ML-DSA-44 signature), and 409 ' +
      '(already-registered domain) response codes the spec documents, and the ' +
      "X-Governance-Token auth header — none of this is reachable without a Nitro runtime; " +
      "this stack's docker-compose.yml has no service for governance/scripts at all."
  );

  it.todo(
    'Script C as a running scheduled task (policy-address-verifier.ts): the poller loop, ' +
      '60s interval, block-cursor persistence, 24-hour SLA alerting, brand-name-list scan, and ' +
      'fraudulent-press-reporting-after-3-violations logic all require the actual defineTask ' +
      'running under a Nitro scheduler — out of reach here. The event this script polls for ' +
      "(PolicyAddressSet) IS covered directly above via a real on-chain write + getLogs read."
  );
});
