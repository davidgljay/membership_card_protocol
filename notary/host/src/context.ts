/**
 * The host's runtime context: everything the handlers need, injected (so tests build one from in-memory parts).
 */
import { hostKeys } from "./receipts/index.js";
import { blobStore, inputStore, jobStore, logStore, receiptStore, snapshotStore } from "./storage/index.js";
import type { HostConfig } from "./config.js";
import type { KvStore } from "./kv.js";
import type { EnclaveSession } from "./enclave/transport.js";
import type { ChainReader, ChainSubmitter, DeliveryClient, EasAnchorer, IpfsService, Monitor, PeerClient, PolicyReader, ReplicaStarter } from "./services.js";

export interface HostDeps {
  config: Pick<HostConfig, "NOTARY_CARD_ADDRESSES" | "NOTARY_HOST_MLDSA44_SEED" | "NOTARY_OHTTP_PRIVATE_KEY" | "NOTARY_RELAY_TARGET_ID" | "NOTARY_PUBLIC_BASE_URL" | "PEER_HOSTS" | "NOTARY_ADMIN_TOKEN">;
  kv: KvStore;
  ipfs: IpfsService;
  eas: EasAnchorer;
  chain: ChainReader;
  submitter: ChainSubmitter;
  policies: PolicyReader;
  peers: PeerClient;
  delivery: DeliveryClient;
  replicas: ReplicaStarter;
  monitor: Monitor;
  /** Live enclave sessions, keyed by vsock CID (or simulator id). */
  sessions: Map<string, EnclaveSession>;
  now?: () => number;
}

export interface HostContext extends HostDeps {
  now: () => number;
  keys: { publicKey: Uint8Array; secretKey: Uint8Array };
  jobs: ReturnType<typeof jobStore>;
  inputs: ReturnType<typeof inputStore>;
  receipts: ReturnType<typeof receiptStore>;
  logs: ReturnType<typeof logStore>;
  snapshots: ReturnType<typeof snapshotStore>;
  blobs: ReturnType<typeof blobStore>;
  /** instance id (SHA-256(K_inst), base64url, learned from `hello_ack`) → session. */
  instances: Map<string, EnclaveSession>;
  /** Objects the enclaves asked the host to serve (announcements, notarizations, counted_inputs, records), by CID. */
  served: Map<string, Uint8Array>;
  /** Notary cards this host serves: `NOTARY_CARD_ADDRESSES` plus every card created through `/genesis` on this host (kept in the KV). */
  cards: { all(): string[]; add(card: string): Promise<void>; load(): Promise<void> };
}

const CARDS_KEY = "notary_cards";

function cardSet(d: HostDeps) {
  const set = new Set<string>(d.config.NOTARY_CARD_ADDRESSES);
  return {
    all: () => [...set],
    async add(card: string) { if (set.has(card)) return; set.add(card); await d.kv.setItem(CARDS_KEY, [...set].filter((c) => !d.config.NOTARY_CARD_ADDRESSES.includes(c))); },
    async load() { for (const c of (await d.kv.getItem<string[]>(CARDS_KEY)) ?? []) if (/^[0-9a-f]{64}$/.test(c)) set.add(c); },
  };
}

export function createContext(d: HostDeps): HostContext {
  return {
    ...d, now: d.now ?? Date.now, keys: hostKeys(d.config.NOTARY_HOST_MLDSA44_SEED),
    jobs: jobStore(d.kv), inputs: inputStore(d.kv), receipts: receiptStore(d.kv), logs: logStore(d.kv), snapshots: snapshotStore(d.kv), blobs: blobStore(d.kv),
    instances: new Map(), served: new Map(), cards: cardSet(d),
  };
}

export class HostError extends Error {
  constructor(public readonly code: string, message: string, public readonly status = 400) { super(message); }
}


