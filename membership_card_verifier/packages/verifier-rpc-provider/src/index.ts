import type {
  RpcProvider,
  CardEntry,
  PressAuthEntry,
  SubCardEntry,
  CardChainEvent,
  EasAttestation,
  DomainRegistration,
  GovernanceKeysetRead,
} from "@membership-card-protocol/verifier";
import { collectNotaryLogAnchors } from "./notaryAnchors.js";
import type { EasReader, NotaryAnchorOptions } from "./notaryAnchors.js";

/**
 * ethers.js v6 implementation of RpcProvider.
 *
 * The registry contract ABI is caller-supplied via the `contract` parameter, which
 * allows integrators to use any version of the ABI without coupling the package to one.
 */

export interface RegistryContract {
  getCardEntry(address: string): Promise<{
    log_head_cid: string;
    policy_address: string;
    last_press_address: string;
    forward_to: string | null;
    exists: boolean;
  }>;
  isPolicyAuthorizer(address: string): Promise<boolean>;
  getPressAuthorization(policyAddress: string, pressAddress: string): Promise<{
    press_public_key: string;
    mldsa44_key_hash: string;
    active: boolean;
    authorized_at: string;
    revoked_at: string | null;
  } | null>;
  getSubCardEntry(subCardAddress: string): Promise<{
    master_card_address: string;
    registration_log_head: string;
    sub_card_doc_cid: string;
    active: boolean;
    registered_at: string;
    deregistered_at: string | null;
  } | null>;
  /**
   * Replays the registry contract's `CardRegistered` (genesis, `initial_log_cid`)
   * and `CardHeadUpdated` (each subsequent entry, `new_log_cid`) events for
   * `cardAddress` and returns the ground-truth, oldest-first CID sequence with
   * each entry's authoritative on-chain `timestamp` (`registry_contract.md §7`).
   * This is the sole responsibility of the caller-supplied ABI/event-querying
   * layer; `EthersRpcProvider` itself only forwards the result.
   */
  getCardEventLog(cardAddress: string): Promise<Array<{
    cid: string;
    timestamp: string;
  }>>;
  getEasAnnotations(cardAddress: string, annotatorAddresses: string[]): Promise<Array<{
    uid: string;
    attester: string;
    cid: string;
    update_code: number;
    effective_date: string;
  }>>;
  /**
   * Card login (card_verifier.md §4.1): the logic contract's
   * `getDomainRegistration(uint8[] domain)` view, returning
   * (admin_card_address, registered_at, fraud_risk, suspension_expires_at, exists).
   * Optional: providers without it cannot be used for card login.
   */
  getDomainRegistration?(domain: string): Promise<{
    admin_card_address: string;
    fraud_risk: number;
    suspension_expires_at: number | bigint;
    exists: boolean;
  }>;
  /**
   * `getGovernanceKeyset(uint8 body_id)` view (registry_contract.md §5): `keys` is the flat byte array of
   * `key_count` keys, 64 bytes each for scheme 0 and 1312 for scheme 1.
   */
  getGovernanceKeyset?(bodyId: number): Promise<{
    keys: ArrayLike<number | bigint> | string;
    key_count: number | bigint;
    quorum: number | bigint;
    version: number | bigint;
    key_scheme: number | bigint;
  }>;
}

/** GovernanceBodyId enum order (registry_contract.md §3.6). */
const GOVERNANCE_BODY_ID = { RootPolicyBody: 0, PressRegistryBody: 1, DnsGovernanceBody: 2 } as const;

export interface EthersRpcProviderOptions {
  /** Reads EAS anchors for `getNotaryLogAnchors`. */
  eas?: EasReader;
  notaryAnchors?: NotaryAnchorOptions;
}

export class EthersRpcProvider implements RpcProvider {
  readonly #contract: RegistryContract;
  readonly #opts: EthersRpcProviderOptions;

  constructor(contract: RegistryContract, opts: EthersRpcProviderOptions = {}) {
    this.#contract = contract;
    this.#opts = opts;
  }

  async getGovernanceKeyset(bodyId: "PressRegistryBody"): Promise<GovernanceKeysetRead> {
    if (!this.#contract.getGovernanceKeyset) throw new Error("RegistryContract.getGovernanceKeyset is not available; the notary checks need it");
    const r = await this.#contract.getGovernanceKeyset(GOVERNANCE_BODY_ID[bodyId]);
    const scheme = Number(r.key_scheme);
    if (scheme !== 0 && scheme !== 1) throw new Error(`unknown governance key_scheme ${scheme}`);
    const flat = typeof r.keys === "string" ? Uint8Array.from(Buffer.from(r.keys.replace(/^0x/, ""), "hex")) : Uint8Array.from(Array.from(r.keys as ArrayLike<number | bigint>, Number));
    const keyLen = scheme === 0 ? 64 : 1312;
    const count = Number(r.key_count);
    if (flat.length !== count * keyLen) throw new Error(`governance keyset: ${flat.length} key bytes for ${count} keys of ${keyLen}`);
    const keys = Array.from({ length: count }, (_, i) => flat.slice(i * keyLen, (i + 1) * keyLen));
    return { keys, quorum: Number(r.quorum), version: Number(r.version), key_scheme: scheme };
  }

  async getNotaryLogAnchors(scopeId: string): Promise<{ seq: number; record_cid: string; timestamp: number }[]> {
    if (!this.#opts.eas || !this.#opts.notaryAnchors) throw new Error("EthersRpcProvider needs `eas` and `notaryAnchors` options for getNotaryLogAnchors");
    return collectNotaryLogAnchors(this.#opts.eas, scopeId, this.#opts.notaryAnchors);
  }

  async getCardEntry(address: string): Promise<CardEntry | null> {
    const entry = await this.#contract.getCardEntry(address);
    if (!entry.exists) return null;
    return entry as CardEntry;
  }

  async isPolicyAuthorizer(address: string): Promise<boolean> {
    return this.#contract.isPolicyAuthorizer(address);
  }

  async getPressAuthorization(
    policyAddress: string,
    pressAddress: string
  ): Promise<PressAuthEntry | null> {
    const entry = await this.#contract.getPressAuthorization(policyAddress, pressAddress);
    return entry as PressAuthEntry | null;
  }

  async getSubCardEntry(subCardAddress: string): Promise<SubCardEntry | null> {
    const entry = await this.#contract.getSubCardEntry(subCardAddress);
    return entry as SubCardEntry | null;
  }

  async getCardEventLog(cardAddress: string): Promise<CardChainEvent[]> {
    const entries = await this.#contract.getCardEventLog(cardAddress);
    return entries as CardChainEvent[];
  }

  async getDomainRegistration(domain: string): Promise<DomainRegistration | null> {
    if (!this.#contract.getDomainRegistration) {
      throw new Error("RegistryContract.getDomainRegistration is not available; card login needs it");
    }
    const entry = await this.#contract.getDomainRegistration(domain.toLowerCase().replace(/\.$/, ""));
    if (!entry.exists) return null;
    return {
      admin_card_address: entry.admin_card_address.toLowerCase().replace(/^0x/, ""),
      fraud_risk: entry.fraud_risk as 0 | 1 | 2,
      suspension_expires_at: Number(entry.suspension_expires_at),
    };
  }

  async getEasAnnotations(
    cardAddress: string,
    annotatorAddresses: string[]
  ): Promise<EasAttestation[]> {
    const entries = await this.#contract.getEasAnnotations(cardAddress, annotatorAddresses);
    return entries as EasAttestation[];
  }
}

export { collectNotaryLogAnchors, scopeToBytes32, EthersEasReader } from "./notaryAnchors.js";
export type { EasReader, NotaryAnchorOptions } from "./notaryAnchors.js";
export { getNetworkConfig } from "./networkConfig.js";
export type { NetworkConfig, NetworkEnv } from "./networkConfig.js";
export { getCardEventLogChunked } from "./chunkedEventLog.js";
export type { ChunkedEventLogOptions } from "./chunkedEventLog.js";
