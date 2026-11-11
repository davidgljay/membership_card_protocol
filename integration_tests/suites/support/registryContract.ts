/**
 * A viem-backed RegistryContract for EthersRpcProvider, shared by the card
 * login suite. Unlike the inline adapters in older suites, it normalizes
 * every address to lowercase hex without 0x — the form the verifier compares
 * against (Stage 2 compares master_card_address to keccak256 output) — and
 * adds getDomainRegistration (card_verifier.md §4.1).
 */
import { parseAbi, type Hex, type PublicClient } from 'viem';
import type { RegistryContract } from '@membership-card-protocol/verifier-rpc-provider';

const STORAGE_ABI = parseAbi([
  'function getCardEntry(bytes32 card_address) external view returns ((uint8[] log_head_cid, bytes32 policy_address, bytes32 last_press_address, bytes32 forward_to, bool exists) r)',
  'function getPressAuthorization(bytes32 policy_address, bytes32 press_address) external view returns ((uint8[] press_public_key, bytes32 mldsa44_key_hash, uint8 key_scheme, bool active, uint64 next_sequence, uint64 authorized_at, uint64 revoked_at) r)',
  'function getSubCardEntry(bytes32 sub_card_address) external view returns ((bytes32 master_card_address, uint8[] registration_log_head, uint8[] sub_card_doc_cid, bool active, uint64 registered_at, uint64 deregistered_at) r)',
]);
const CARD_REGISTERED_EVENT = parseAbi([
  'event CardRegistered(bytes32 indexed card_address, bytes32 indexed policy_address, bytes32 press_address, bytes initial_log_cid, uint64 timestamp)',
])[0];
const CARD_HEAD_UPDATED_EVENT = parseAbi([
  'event CardHeadUpdated(bytes32 indexed card_address, bytes prev_log_cid, bytes new_log_cid, bytes32 press_address, uint64 timestamp)',
])[0];
const LOGIC_ABI = parseAbi([
  'function getDomainRegistration(uint8[] domain) external view returns (bytes32, uint64, uint8, uint64, bool)',
]);

const ZERO = '00'.repeat(32);
const norm = (a: string) => a.toLowerCase().replace(/^0x/, '');
const hex0x = (a: string) => ('0x' + norm(a)) as Hex;
const cid = (bytes: readonly number[]) => new TextDecoder().decode(Uint8Array.from(bytes));
const hex = (bytes: readonly number[]) => Uint8Array.from(bytes).reduce((s, b) => s + b.toString(16).padStart(2, '0'), '');

export function createRegistryContract(client: PublicClient, storageAddress: Hex, logicAddress: Hex): RegistryContract {
  return {
    async getCardEntry(address) {
      const t = (await client.readContract({ address: storageAddress, abi: STORAGE_ABI, functionName: 'getCardEntry', args: [hex0x(address)] })) as unknown as {
        log_head_cid: readonly number[]; policy_address: Hex; last_press_address: Hex; forward_to: Hex; exists: boolean;
      };
      return {
        log_head_cid: cid(t.log_head_cid),
        policy_address: norm(t.policy_address),
        last_press_address: norm(t.last_press_address),
        forward_to: norm(t.forward_to) === ZERO ? null : norm(t.forward_to),
        exists: t.exists,
      };
    },
    async isPolicyAuthorizer() {
      return false;
    },
    async getPressAuthorization(policyAddress, pressAddress) {
      const t = (await client.readContract({ address: storageAddress, abi: STORAGE_ABI, functionName: 'getPressAuthorization', args: [hex0x(policyAddress), hex0x(pressAddress)] })) as unknown as {
        press_public_key: readonly number[]; mldsa44_key_hash: Hex; active: boolean; authorized_at: bigint; revoked_at: bigint;
      };
      if (!t.active && t.authorized_at === 0n) return null;
      return { press_public_key: hex(t.press_public_key), mldsa44_key_hash: t.mldsa44_key_hash, active: t.active, authorized_at: String(t.authorized_at), revoked_at: t.revoked_at === 0n ? null : String(t.revoked_at) };
    },
    async getSubCardEntry(subCardAddress) {
      const t = (await client.readContract({ address: storageAddress, abi: STORAGE_ABI, functionName: 'getSubCardEntry', args: [hex0x(subCardAddress)] })) as unknown as {
        master_card_address: Hex; registration_log_head: readonly number[]; sub_card_doc_cid: readonly number[]; active: boolean; registered_at: bigint; deregistered_at: bigint;
      };
      if (norm(t.master_card_address) === ZERO) return null;
      return {
        master_card_address: norm(t.master_card_address),
        registration_log_head: cid(t.registration_log_head),
        sub_card_doc_cid: cid(t.sub_card_doc_cid),
        active: t.active,
        registered_at: String(t.registered_at),
        deregistered_at: t.deregistered_at === 0n ? null : String(t.deregistered_at),
      };
    },
    // CardRegistered + CardHeadUpdated, oldest first (registry_contract.md §7),
    // the same events the press replays — Stage 4 checks a LogEntry's
    // history and effective dates against them.
    async getCardEventLog(cardAddress) {
      const args = { card_address: hex0x(cardAddress) };
      const [registered, updated] = await Promise.all([
        client.getLogs({ address: logicAddress, event: CARD_REGISTERED_EVENT, args, fromBlock: 0n, toBlock: 'latest' }),
        client.getLogs({ address: logicAddress, event: CARD_HEAD_UPDATED_EVENT, args, fromBlock: 0n, toBlock: 'latest' }),
      ]);
      const text = (h: Hex) => new TextDecoder().decode(Uint8Array.from((h.slice(2).match(/../g) ?? []).map((b) => parseInt(b, 16))));
      return [
        ...registered.map((l) => ({ cid: text(l.args.initial_log_cid!), ts: l.args.timestamp!, b: l.blockNumber ?? 0n, i: l.logIndex ?? 0 })),
        ...updated.map((l) => ({ cid: text(l.args.new_log_cid!), ts: l.args.timestamp!, b: l.blockNumber ?? 0n, i: l.logIndex ?? 0 })),
      ]
        .sort((a, b) => (a.b === b.b ? a.i - b.i : Number(a.b - b.b)))
        .map((e) => ({ cid: e.cid, timestamp: new Date(Number(e.ts) * 1000).toISOString() }));
    },
    async getEasAnnotations() {
      return [];
    },
    async getDomainRegistration(domain) {
      const [admin, , fraudRisk, suspensionExpiresAt, exists] = (await client.readContract({
        address: logicAddress, abi: LOGIC_ABI, functionName: 'getDomainRegistration', args: [Array.from(new TextEncoder().encode(domain))],
      })) as unknown as [Hex, bigint, number, bigint, boolean];
      return { admin_card_address: norm(admin), fraud_risk: Number(fraudRisk), suspension_expires_at: suspensionExpiresAt, exists };
    },
  };
}
