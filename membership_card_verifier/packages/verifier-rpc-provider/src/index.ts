import type {
  RpcProvider,
  CardEntry,
  PressAuthEntry,
  SubCardEntry,
  CardChainEvent,
  EasAttestation,
  DomainRegistration,
} from "@membership-card-protocol/verifier";

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
}

export class EthersRpcProvider implements RpcProvider {
  readonly #contract: RegistryContract;

  constructor(contract: RegistryContract) {
    this.#contract = contract;
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

export { getNetworkConfig } from "./networkConfig.js";
export type { NetworkConfig, NetworkEnv } from "./networkConfig.js";
export { getCardEventLogChunked } from "./chunkedEventLog.js";
export type { ChunkedEventLogOptions } from "./chunkedEventLog.js";
