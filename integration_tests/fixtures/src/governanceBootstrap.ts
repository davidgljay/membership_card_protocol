/**
 * Idempotent bootstrap for a fresh local nitro-devnode deployment:
 * - Funds press's gas wallet from the chain's prefunded dev account (it
 *   starts at zero every restart, unlike Sepolia's once-funded account).
 * - RegisterPolicy + AuthorizePress for a given policy/press, using the
 *   genesis governance keypair `deploy-contracts`' bootstrap.sh already
 *   generates and records in `contracts/deployments/local.json`
 *   (`dev_governance_keypair`). That keypair is genesis-seeded as the 1-of-1
 *   keyset for all three governance bodies (Root, PressRegistry, Dns) by
 *   `storage-contract`'s own `initialize()` — see its doc comment — so it's
 *   already authoritative for both operations here without any extra setup.
 *
 * On real Sepolia this bootstrap only ever needed to happen once, by hand
 * (see reports/phase-1-environment-notes.md); nitro-devnode resets all
 * chain state on every restart, so it needs to run automatically on every
 * stack bring-up instead. Safe to call unconditionally — checks on-chain
 * state first and no-ops if the policy/press are already registered.
 *
 * Two of this module's crypto operations are deliberately *not*
 * reimplemented here: canonical governance-payload JSON construction and
 * secp256r1 payload signing. Both already exist as tested Rust binaries
 * (contracts/scripts/build_governance_payload.rs, sign_payload.rs) that
 * `bootstrap.sh` itself shells out to — reusing them via `cargo run`
 * avoids a second, independent (and therefore riskier) implementation of
 * RFC 8785 canonicalization and RFC 6979 deterministic ECDSA signing.
 * `verify_governance_quorum` (write_gate.rs) only checks the payload's
 * `governance_version`/`nonce` fields and the signature over the raw
 * payload bytes — it never cross-validates the payload's informational
 * `policy`/`press`/`press_pubkey` fields against the actual call
 * arguments, so this module doesn't need to match those exactly either.
 */

import { execFileSync } from 'node:child_process';
import { createPublicClient, createWalletClient, http, parseAbi, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { arbitrumSepolia } from 'viem/chains';
import { p256 } from '@noble/curves/p256';
import { mlDsa44GetPublicKey, keccak256 } from '@membership-card-protocol/app-sdk';

// The standard prefunded dev account nitro-devnode's `--dev` mode seeds —
// same key contracts/scripts/deploy.sh's "local" case uses to pay gas.
// Only pays transaction fees; carries no governance authority of its own.
const DEV_GAS_PRIVATE_KEY = '0xb6b15c8cb491557369f3c7d2c287b053eb229daa9c22138887752191c9520659';

const ROOT_POLICY_BODY = 0;
const PRESS_REGISTRY_BODY = 1;

const STORAGE_ABI = parseAbi([
  'function policyExists(bytes32 policy_address) external view returns (bool)',
  'function isPressActive(bytes32 policy_address, bytes32 press_address) external view returns (bool)',
  // uint8[] mixed with static fields needs an explicit outer tuple for the
  // decoder — see bootstrap.sh's doc comment on this exact ABI shape.
  'function getGovernanceKeyset(uint8 body_id) external view returns ((uint8[] keys, uint8 key_count, uint8 quorum, uint32 version, uint8 key_scheme) r)',
]);

const LOGIC_ABI = parseAbi([
  'function registerPolicy(bytes32 policy_address, uint8[] authorizer_pubkey, uint8[] governance_payload, uint8[][] governance_sigs) external',
  'function authorizePress(bytes32 policy_address, bytes32 press_address, uint8[] press_pubkey, bytes32 mldsa44_key_hash, uint8[] governance_payload, uint8[][] governance_sigs) external',
]);

export interface GovernanceKeypair {
  public_key: string;
  private_key: string;
}

export interface EnsureGovernanceBootstrapOptions {
  rpcUrl: string;
  logicAddress: Hex;
  storageAddress: Hex;
  /** 0x-prefixed or not — normalized internally either way. */
  policyAddress: string;
  /** The press's on-chain PressAuthorizations lookup key — press.get.ts's `gas_address` field. */
  pressAddress: Hex;
  /** Raw 32-byte P-256 scalar (0x-prefixed or not) — press's PRESS_SECP256R1_PRIVATE_KEY. */
  pressSecp256r1PrivateKey: string;
  /** Press's ML-DSA-44 secret key — PRESS_MLDSA44_PRIVATE_KEY. */
  pressMlDsa44PrivateKey: Uint8Array;
  governanceKeypair: GovernanceKeypair;
  /**
   * Press's gas wallet — PRESS_GAS_WALLET_PRIVATE_KEY. On Sepolia this
   * account already held real testnet ETH (funded once, by hand); on a
   * fresh local nitro-devnode it starts at zero every restart, so it needs
   * topping up from the chain's own prefunded dev account before press can
   * pay for any on-chain write (RegisterCard, etc).
   */
  pressGasWalletPrivateKey: string;
  /** Path to contracts/scripts, for the cargo-run signing/payload helpers. */
  contractsScriptsDir: string;
}

/** Below this balance, top the account back up to FUND_TARGET_WEI. */
const FUND_THRESHOLD_WEI = 10n ** 16n; // 0.01 ETH
const FUND_TARGET_WEI = 10n ** 18n; // 1 ETH

function normalizeHexKey(key: string): Hex {
  return (key.startsWith('0x') ? key : `0x${key}`) as Hex;
}

function bytesToUint8Array(bytes: Uint8Array): number[] {
  return Array.from(bytes);
}

function hexToBytesArg(hex: string): number[] {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return bytesToUint8Array(bytes);
}

function buildGovernancePayload(
  scriptsDir: string,
  op: 'register_policy' | 'authorize_press',
  version: number
): string {
  return execFileSync(
    'cargo',
    ['run', '--manifest-path', `${scriptsDir}/Cargo.toml`, '--bin', 'build_governance_payload', '--quiet', '--', '--op', op, '--version', String(version)],
    { encoding: 'utf-8' }
  ).trim();
}

function signPayload(scriptsDir: string, privateKeyHex: string, payload: string): string {
  return execFileSync(
    'cargo',
    ['run', '--manifest-path', `${scriptsDir}/Cargo.toml`, '--bin', 'sign_payload', '--quiet', '--', '--key-hex', normalizeHexKey(privateKeyHex), '--payload', payload],
    { encoding: 'utf-8' }
  ).trim();
}

/** Derives the 64-byte (x||y) P-256 public key from a raw 32-byte scalar — the format authorizePress's press_pubkey expects. */
function p256PublicKeyXY(privateKeyHex: string): Uint8Array {
  const raw = new Uint8Array(hexToBytesArg(normalizeHexKey(privateKeyHex)));
  const uncompressed = p256.getPublicKey(raw, false); // 0x04 || x || y (65 bytes)
  return uncompressed.slice(1);
}

export async function ensureGovernanceBootstrap(options: EnsureGovernanceBootstrapOptions): Promise<void> {
  const publicClient = createPublicClient({ chain: arbitrumSepolia, transport: http(options.rpcUrl) });
  const gasAccount = privateKeyToAccount(DEV_GAS_PRIVATE_KEY);
  const walletClient = createWalletClient({ account: gasAccount, chain: arbitrumSepolia, transport: http(options.rpcUrl) });

  const pressGasAddress = privateKeyToAccount(normalizeHexKey(options.pressGasWalletPrivateKey)).address;
  const pressGasBalance = await publicClient.getBalance({ address: pressGasAddress });
  if (pressGasBalance < FUND_THRESHOLD_WEI) {
    const fundHash = await walletClient.sendTransaction({ to: pressGasAddress, value: FUND_TARGET_WEI });
    await publicClient.waitForTransactionReceipt({ hash: fundHash, timeout: 120_000 });
  }

  const policyAddressHex = normalizeHexKey(options.policyAddress) as Hex;

  const policyExists = await publicClient.readContract({
    address: options.storageAddress,
    abi: STORAGE_ABI,
    functionName: 'policyExists',
    args: [policyAddressHex],
  });

  if (!policyExists) {
    const keyset = await publicClient.readContract({
      address: options.storageAddress,
      abi: STORAGE_ABI,
      functionName: 'getGovernanceKeyset',
      args: [ROOT_POLICY_BODY],
    });
    const version = keyset.version;

    const payload = buildGovernancePayload(options.contractsScriptsDir, 'register_policy', version);
    const sigHex = signPayload(options.contractsScriptsDir, options.governanceKeypair.private_key, payload);

    const authorizerPubkey = hexToBytesArg(options.governanceKeypair.public_key);

    const hash = await walletClient.writeContract({
      address: options.logicAddress,
      abi: LOGIC_ABI,
      functionName: 'registerPolicy',
      args: [
        policyAddressHex,
        authorizerPubkey,
        Array.from(new TextEncoder().encode(payload)),
        [hexToBytesArg(sigHex)],
      ],
    });
    await publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 });
  }

  const pressActive = await publicClient.readContract({
    address: options.storageAddress,
    abi: STORAGE_ABI,
    functionName: 'isPressActive',
    args: [policyAddressHex, options.pressAddress],
  });

  if (!pressActive) {
    const keyset = await publicClient.readContract({
      address: options.storageAddress,
      abi: STORAGE_ABI,
      functionName: 'getGovernanceKeyset',
      args: [PRESS_REGISTRY_BODY],
    });
    const version = keyset.version;

    const payload = buildGovernancePayload(options.contractsScriptsDir, 'authorize_press', version);
    const sigHex = signPayload(options.contractsScriptsDir, options.governanceKeypair.private_key, payload);

    const pressPubkeyXY = p256PublicKeyXY(options.pressSecp256r1PrivateKey);
    const mldsa44Pubkey = mlDsa44GetPublicKey(options.pressMlDsa44PrivateKey);
    const mldsa44KeyHash = ('0x' + keccak256(mldsa44Pubkey)) as Hex;

    const hash = await walletClient.writeContract({
      address: options.logicAddress,
      abi: LOGIC_ABI,
      functionName: 'authorizePress',
      args: [
        policyAddressHex,
        options.pressAddress,
        bytesToUint8Array(pressPubkeyXY),
        mldsa44KeyHash,
        Array.from(new TextEncoder().encode(payload)),
        [hexToBytesArg(sigHex)],
      ],
    });
    await publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 });
  }
}
