/**
 * The production chain clients (`CHAIN_PROVIDER=rpc`, notary_host.md §8 and §10) over viem: the registry reads and the
 * chain feed behind the schedulers, and the gas-wallet submitter for enclave-signed registry payloads.
 *
 * They implement the same interfaces as the simulated chain (`../sim/index.ts`), so the host code above them is the code
 * that runs in production. Nothing here decides anything: the enclave re-checks every object (notary_host.md §2).
 *
 * Shapes follow the simulator's: addresses are lowercase hex without `0x` (32 bytes), head CIDs are the text the registry
 * holds as bytes. A submit is sent **unchanged**: the contract's write gate (registry_contract §6.1) checks the press
 * signature, the sequence and that the signed payload equals the calldata (step 8, E-49).
 *
 * Header RLP comes from `debug_getRawHeader`; a provider without the debug API cannot feed the schedulers (the devnode
 * and a self-run Arbitrum node expose it).
 */
import { createPublicClient, createWalletClient, http, parseAbi, toHex, hexToBytes, bytesToHex, type Hex, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { canonicalNotary, b64uDecode, b64uEncode } from "@membership-card-protocol/wallet-sdk/notary-types";
import type { ChainFeed, ChainReader, ChainSubmitter } from "../services.js";
import type { RegistryEvent, SubCardEvent } from "./snapshots.js";
import { easAnchorer } from "../eas/index.js";

const LOGIC_ABI = parseAbi([
  "function registerCard(bytes32 card_address, uint8[] initial_log_cid, bytes32 policy_address, bytes32 press_address, uint8[] press_sig_payload, uint8[] press_signature) external",
  "function updateCardHead(bytes32 card_address, uint8[] new_log_cid, uint8[] prev_log_cid, bytes32 press_address, uint8[] press_sig_payload, uint8[] press_signature) external",
  "function batchUpdateCardHeads(bytes32 policy_address, bytes32 press_address, bytes32[] card_addresses, uint8[][] prev_log_cids, uint8[][] new_log_cids, uint8[] press_sig_payload, uint8[] press_signature) external",
  "function getProtocolVersion() external view returns (string)",
]);
const STORAGE_ABI = parseAbi([
  "function getCardEntry(bytes32 card_address) external view returns ((uint8[] log_head_cid, bytes32 policy_address, bytes32 last_press_address, bytes32 forward_to, bool exists) r)",
  "function getPressAuthorization(bytes32 policy_address, bytes32 press_address) external view returns ((uint8[] press_public_key, bytes32 mldsa44_key_hash, uint8 key_scheme, bool active, uint64 next_sequence, uint64 authorized_at, uint64 revoked_at) r)",
  "function getSubCardEntry(bytes32 sub_card_address) external view returns ((bytes32 master_card_address, uint8[] registration_log_head, uint8[] sub_card_doc_cid, bool active, uint64 registered_at, uint64 deregistered_at) r)",
]);
const EAS_ABI = parseAbi([
  "function attest((bytes32 schema, (address recipient, uint64 expirationTime, bool revocable, bytes32 refUID, bytes data, uint256 value) data) request) external payable returns (bytes32)",
]);
const EVENTS = parseAbi([
  "event CardRegistered(bytes32 indexed card_address, bytes32 indexed policy_address, bytes32 press_address, bytes initial_log_cid, uint64 timestamp)",
  "event CardHeadUpdated(bytes32 indexed card_address, bytes prev_log_cid, bytes new_log_cid, bytes32 press_address, uint64 timestamp)",
  "event SubCardRegistered(bytes32 indexed sub_card_address, bytes32 indexed master_address, bytes sub_card_doc_cid, uint64 timestamp)",
  "event SubCardDeregistered(bytes32 indexed sub_card_address, bytes32 master_address, uint64 timestamp)",
]);

export interface RpcChainConfig {
  rpcUrl: string;
  logicContract: string;
  storageContract: string;
  /** The gas wallet's private key (hex). It pays for transactions and signs nothing else. */
  gasWalletKey: string;
  /** EAS and the notary job-log schema's UID (`governance/scripts/notary-eas.ts`); without them `eas` is absent and a host cannot start. */
  easContract?: string;
  easSchemaUid?: string;
}

const hex32 = (h: string) => `0x${h.replace(/^0x/, "").toLowerCase()}` as Hex;
const noPrefix = (h: string) => h.replace(/^0x/, "").toLowerCase();
const cidText = (bytesHex: Hex) => new TextDecoder().decode(hexToBytes(bytesHex));
const bytesArg = (b: Uint8Array) => [...b];
const isoOf = (seconds: bigint | number) => new Date(Number(seconds) * 1000).toISOString();
/** Calldata and payload fields are unpadded base64url; the contract takes bytes32 or bytes. */
const addrOf = (b64: string) => bytesToHex(b64uDecode(b64)) as Hex;

export function rpcChain(c: RpcChainConfig, injected?: { publicClient?: PublicClient }) {
  const logic = hex32(c.logicContract), storage = hex32(c.storageContract);
  const publicClient = (injected?.publicClient ?? createPublicClient({ transport: http(c.rpcUrl) })) as PublicClient;
  const account = privateKeyToAccount(hex32(c.gasWalletKey));
  const wallet = createWalletClient({ account, transport: http(c.rpcUrl) });

  const entry = async (address: string) => {
    const r = (await publicClient.readContract({ address: storage, abi: STORAGE_ABI, functionName: "getCardEntry", args: [hex32(address)] })) as unknown as
      { log_head_cid: readonly number[]; policy_address: Hex; last_press_address: Hex; forward_to: Hex; exists: boolean };
    return r.exists ? r : null;
  };
  const toText = (a: readonly number[]) => new TextDecoder().decode(Uint8Array.from(a));

  async function cardEvents(address: string) {
    const addr = hex32(address);
    const [reg, upd] = await Promise.all([
      publicClient.getLogs({ address: logic, event: EVENTS[0], args: { card_address: addr }, fromBlock: 0n, toBlock: "latest" }),
      publicClient.getLogs({ address: logic, event: EVENTS[1], args: { card_address: addr }, fromBlock: 0n, toBlock: "latest" }),
    ]);
    return [
      ...reg.map((l) => ({ cid: cidText(l.args.initial_log_cid!), timestamp: isoOf(l.args.timestamp!), block: Number(l.blockNumber), idx: l.logIndex })),
      ...upd.map((l) => ({ cid: cidText(l.args.new_log_cid!), timestamp: isoOf(l.args.timestamp!), block: Number(l.blockNumber), idx: l.logIndex })),
    ].sort((a, b) => a.block - b.block || a.idx - b.idx);
  }

  const chain: ChainReader = {
    // notary_host.md §8 shape: { head_cid, events }, canonical JSON
    async cardHead(address) {
      const e = await entry(address);
      if (!e) return null;
      const events = (await cardEvents(address)).map(({ cid, timestamp }) => ({ cid, timestamp }));
      return canonicalNotary({ events, head_cid: toText(e.log_head_cid) } as never);
    },
    async pressAuth(policy, press) {
      const r = (await publicClient.readContract({ address: storage, abi: STORAGE_ABI, functionName: "getPressAuthorization", args: [hex32(policy), hex32(press)] })) as unknown as
        { press_public_key: readonly number[]; active: boolean; next_sequence: bigint; authorized_at: bigint };
      return r.authorized_at === 0n ? null : { next_sequence: Number(r.next_sequence), active: r.active, press_public_key: b64uEncode(Uint8Array.from(r.press_public_key)) };
    },
    async protocolVersion() { try { return (await publicClient.readContract({ address: logic, abi: LOGIC_ABI, functionName: "getProtocolVersion" })) as string; } catch { return null; } },
    async subcard(address) {
      const r = (await publicClient.readContract({ address: storage, abi: STORAGE_ABI, functionName: "getSubCardEntry", args: [hex32(address)] })) as unknown as
        { master_card_address: Hex; sub_card_doc_cid: readonly number[]; registered_at: bigint; active: boolean };
      return r.registered_at === 0n ? null : { master_card_address: noPrefix(r.master_card_address), sub_card_doc_cid: toText(r.sub_card_doc_cid), active: r.active };
    },
    events: async () => null,
  };

  const feed: ChainFeed = {
    async headersAfter(n) {
      const latest = Number(await publicClient.getBlockNumber());
      const out: { number: number; header_rlp: string; timestamp: number }[] = [];
      for (let b = n + 1; b <= Math.min(latest, n + 256); b++) {
        const [raw, blk] = await Promise.all([
          publicClient.request({ method: "debug_getRawHeader" as never, params: [toHex(b)] as never }) as Promise<Hex>,
          publicClient.getBlock({ blockNumber: BigInt(b) }),
        ]);
        out.push({ number: b, header_rlp: b64uEncode(hexToBytes(raw)), timestamp: Number(blk.timestamp) });
      }
      return out;
    },
    async registry(policy) {
      const p = hex32(policy);
      const registered = await publicClient.getLogs({ address: logic, event: EVENTS[0], args: { policy_address: p }, fromBlock: 0n, toBlock: "latest" });
      const cards = new Set(registered.map((l) => noPrefix(l.args.card_address!)));
      const updated = (await publicClient.getLogs({ address: logic, event: EVENTS[1], fromBlock: 0n, toBlock: "latest" })).filter((l) => cards.has(noPrefix(l.args.card_address!)));
      const events: RegistryEvent[] = [
        ...registered.map((l) => ({ kind: "CardRegistered" as const, policyAddress: policy, cardAddress: noPrefix(l.args.card_address!), headCid: cidText(l.args.initial_log_cid!), pressAddress: noPrefix(l.args.press_address!), block: Number(l.blockNumber), timestamp: isoOf(l.args.timestamp!) })),
        ...updated.map((l) => ({ kind: "CardHeadUpdated" as const, policyAddress: policy, cardAddress: noPrefix(l.args.card_address!), headCid: cidText(l.args.new_log_cid!), pressAddress: noPrefix(l.args.press_address!), block: Number(l.blockNumber), timestamp: isoOf(l.args.timestamp!) })),
      ];
      const subLogs = (await publicClient.getLogs({ address: logic, event: EVENTS[2], fromBlock: 0n, toBlock: "latest" })).filter((l) => cards.has(noPrefix(l.args.master_address!)));
      const unreg = new Set((await publicClient.getLogs({ address: logic, event: EVENTS[3], fromBlock: 0n, toBlock: "latest" })).map((l) => noPrefix(l.args.sub_card_address!)));
      const subcards: SubCardEvent[] = subLogs.map((l) => ({ masterCard: noPrefix(l.args.master_address!), subCard: noPrefix(l.args.sub_card_address!), subCardDocCid: cidText(l.args.sub_card_doc_cid!), active: !unreg.has(noPrefix(l.args.sub_card_address!)), block: Number(l.blockNumber) }));
      const block = Number(await publicClient.getBlockNumber());
      const pe = await entry(policy);
      return { events, subcards, block, policyHead: pe ? toText(pe.log_head_cid) : null };
    },
  };

  const submitter: ChainSubmitter = {
    async submit(s) {
      try {
        const payloadBytes = canonicalNotary(s.payload as never);
        const sig = b64uDecode(s.signature);
        const cd = s.calldata as Record<string, unknown>;
        const pl = s.payload as Record<string, unknown>;
        const common = { account, address: logic, abi: LOGIC_ABI } as const;
        let hash: Hex;
        if (s.op === "register_card") {
          hash = await wallet.writeContract({ ...common, chain: null, functionName: "registerCard",
            args: [addrOf(String(cd["card_address"])), bytesArg(b64uDecode(String(cd["initial_log_cid"]))), addrOf(String(cd["policy_address"])), addrOf(String(cd["press_address"])), bytesArg(payloadBytes), bytesArg(sig)] });
        } else if (s.op === "batch_update_card_heads") {
          const ups = cd["updates"] as { card_address: string; prev_log_cid: string; new_log_cid: string }[];
          hash = await wallet.writeContract({ ...common, chain: null, functionName: "batchUpdateCardHeads",
            args: [addrOf(String(cd["policy_address"])), addrOf(String(cd["press_address"])), ups.map((u) => addrOf(u.card_address)), ups.map((u) => bytesArg(b64uDecode(u.prev_log_cid))), ups.map((u) => bytesArg(b64uDecode(u.new_log_cid))), bytesArg(payloadBytes), bytesArg(sig)] });
        } else if (s.op === "update_card_head") {
          hash = await wallet.writeContract({ ...common, chain: null, functionName: "updateCardHead",
            args: [addrOf(String(cd["card_address"])), bytesArg(b64uDecode(String(cd["new_log_cid"]))), bytesArg(b64uDecode(String(cd["prev_log_cid"]))), addrOf(String(pl["press_address"])), bytesArg(payloadBytes), bytesArg(sig)] });
        } else return { failed: `UNSUPPORTED_OP:${s.op}` };
        const receipt = await publicClient.waitForTransactionReceipt({ hash });
        return receipt.status === "success" ? { txHash: hash } : { failed: "REVERTED" };
      } catch (e) {
        const m = e instanceof Error ? e.message : String(e);
        // a contract revert names its error; keep that, not the whole viem trace
        return { failed: /E-?\d+|[A-Z][A-Z_]{4,}/.exec(m)?.[0] ?? m.slice(0, 200) };
      }
    },
  };

  /** One non-revocable attestation, with no recipient, expiry or value, under the notary schema, from the gas wallet. */
  const eas = c.easContract && c.easSchemaUid
    ? easAnchorer(async (schema, data) => {
        const hash = await wallet.writeContract({ account, address: hex32(c.easContract!), abi: EAS_ABI, chain: null, functionName: "attest",
          args: [{ schema: schema as Hex, data: { recipient: "0x0000000000000000000000000000000000000000", expirationTime: 0n, revocable: false, refUID: `0x${"00".repeat(32)}`, data: data as Hex, value: 0n } }] });
        const receipt = await publicClient.waitForTransactionReceipt({ hash });
        if (receipt.status !== "success") throw new Error(`EAS attest reverted: ${hash}`);
        return { txHash: hash };
      }, c.easSchemaUid)
    : undefined;

  /** The gas wallet's balance, and the chain's ID (the host compares it with `EXPECTED_CHAIN_ID` at startup). */
  const gas = { balanceWei: () => publicClient.getBalance({ address: account.address }) };
  const chainId = () => publicClient.getChainId();

  return { chain, feed, submitter, eas, gas, chainId, publicClient, account: account.address };
}
