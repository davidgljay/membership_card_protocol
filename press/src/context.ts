/**
 * PressContext — holds all initialized clients for a single process lifetime.
 *
 * Created once in server/plugins/startup.ts and retrieved via getPressContext()
 * in handlers. In serverless environments this resets per cold start.
 */

import { CardVerifier } from '@membership-card-protocol/verifier';
import type { RpcProvider, IpfsProvider, CardEntry, PressAuthEntry, SubCardEntry, LogEntry } from '@membership-card-protocol/verifier';
import type { PressConfig } from './config.js';
import type { KvStore } from './kv.js';
import type { IpfsPinningProvider } from './ipfs/provider.js';
import type { RegistryClient } from './chain/registry.js';
import type { GasManager } from './chain/gas.js';
import { mlDsa44PublicKeyFromPrivate } from './functions/crypto.js';
import { toBase64url, fromBase64url } from './functions/crypto.js';
import type { Hex } from 'viem';

export interface PressContext {
  config: PressConfig;
  kv: KvStore;
  verifier: CardVerifier;
  registry: RegistryClient;
  ipfs: IpfsPinningProvider;
  gas: GasManager;
  /** ML-DSA-44 public key (1312 bytes) derived from the private key at startup. */
  pressPublicKey: Uint8Array;
  /** On-chain address of the press (hex bytes32). */
  pressAddress: string;
}

let ctx: PressContext | null = null;

export function setPressContext(context: PressContext): void {
  ctx = context;
}

export function getPressContext(): PressContext {
  if (!ctx) throw new Error('PressContext not initialized — startup plugin has not run');
  return ctx;
}

// ---------------------------------------------------------------------------
// CardVerifier RPC + IPFS provider adapters
// ---------------------------------------------------------------------------

/**
 * Bridges the press's RegistryClient to the CardVerifier's RpcProvider interface.
 *
 * Key conversions:
 * - RegistryClient uses viem Hex types; the verifier uses plain strings.
 * - log_head_cid from the registry is Uint8Array CID bytes; verifier wants a string CID.
 * - getLogEntries walks the CID-linked log chain from IPFS (OQ-B3).
 */
export function createRpcProvider(
  registry: RegistryClient,
  ipfs: IpfsPinningProvider
): RpcProvider {
  return {
    async getCardEntry(address: string): Promise<CardEntry | null> {
      try {
        const entry = await registry.getCardEntry(address as Hex);
        if (!entry.exists) return null;
        return {
          log_head_cid: cidBytesToString(entry.log_head_cid),
          policy_address: entry.policy_address,
          last_press_address: entry.last_press_address,
          forward_to: entry.forward_to === '0x' + '00'.repeat(32) ? null : entry.forward_to,
          exists: entry.exists,
        };
      } catch {
        return null;
      }
    },

    async isPolicyAuthorizer(address: string): Promise<boolean> {
      // A card is a policy authorizer if it has an entry in PolicyAuthorizerKeys.
      // We approximate this by checking if it has any press authorizations under it.
      // The verifier uses this only to determine trusted-root status in verifyCard().
      try {
        const entry = await registry.getCardEntry(address as Hex);
        // Addresses with active cards that were issued under themselves are policy roots.
        // For now: a trusted root must be explicitly listed in config.trustedRoots.
        return false;
      } catch {
        return false;
      }
    },

    async getPressAuthorization(
      policyAddress: string,
      pressAddress: string
    ): Promise<PressAuthEntry | null> {
      try {
        const entry = await registry.getPressAuthorization(
          policyAddress as Hex,
          pressAddress as Hex
        );
        if (!entry.active) return null;
        return {
          press_public_key: toBase64url(entry.press_public_key),
          mldsa44_key_hash: entry.mldsa44_key_hash,
          active: entry.active,
          authorized_at: entry.authorized_at.toString(),
          revoked_at: entry.revoked_at === 0n ? null : entry.revoked_at.toString(),
        };
      } catch {
        return null;
      }
    },

    async getSubCardEntry(subCardAddress: string): Promise<SubCardEntry | null> {
      try {
        const entry = await registry.getSubCardEntry(subCardAddress as Hex);
        return {
          master_card_address: entry.master_card_address,
          registration_log_head: cidBytesToString(entry.registration_log_head),
          sub_card_doc_cid: cidBytesToString(entry.sub_card_doc_cid),
          active: entry.active,
          registered_at: entry.registered_at.toString(),
          deregistered_at: entry.deregistered_at === 0n ? null : entry.deregistered_at.toString(),
        };
      } catch {
        return null;
      }
    },

    async getLogEntries(cardAddress: string): Promise<LogEntry[]> {
      // Walk the CID-linked log chain from the on-chain head (OQ-B3).
      // Returns entries in reverse chronological order (newest first).
      const MAX_WALK = 64;
      try {
        const cardEntry = await registry.getCardEntry(cardAddress as Hex);
        if (!cardEntry.exists) return [];

        const entries: LogEntry[] = [];
        let cid = cidBytesToString(cardEntry.log_head_cid);
        let depth = 0;

        while (cid && depth < MAX_WALK) {
          try {
            const bytes = await ipfs.fetchFromIPFS(cid);
            const doc = JSON.parse(new TextDecoder().decode(bytes)) as {
              code?: number;
              effective_date?: string;
              prev_log_root?: string;
            };
            if (doc.code !== undefined) {
              entries.push({
                update_code: doc.code,
                effective_date: doc.effective_date ?? new Date().toISOString(),
                cid,
              });
            }
            cid = doc.prev_log_root ?? '';
            depth++;
          } catch {
            break;
          }
        }
        return entries;
      } catch {
        return [];
      }
    },

    async getEasAnnotations(): Promise<[]> {
      return [];
    },
  };
}

export function createIpfsProviderAdapter(ipfsClient: IpfsPinningProvider): IpfsProvider {
  return {
    async fetch(cid: string): Promise<Uint8Array> {
      return ipfsClient.fetchFromIPFS(cid);
    },
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function buildCardVerifier(
  config: PressConfig,
  registry: RegistryClient,
  ipfsClient: IpfsPinningProvider
): CardVerifier {
  const rpc = createRpcProvider(registry, ipfsClient);
  const ipfsProvider = createIpfsProviderAdapter(ipfsClient);
  return new CardVerifier({
    rpc,
    ipfs: ipfsProvider,
    trustedRoots: config.PRESS_POLICY_CIDS, // policy CIDs are treated as trusted roots
    revocationFreshnessWindowSeconds: config.STALENESS_WINDOW_SECONDS,
    rejectStaleRevocation: true,
    fetchAnnotations: false,
  });
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

/**
 * Convert raw CID bytes (as returned by the registry contract) to a CIDv1 string.
 * Filebase/IPFS returns CIDv1 strings like `bafybei...`. The registry stores the
 * same CID as raw multihash bytes. For the verifier we need the string form.
 *
 * If the bytes look like a UTF-8 string already (e.g. because they were stored
 * as the string bytes), decode directly; otherwise encode as base32 CIDv1.
 */
function cidBytesToString(bytes: Uint8Array): string {
  if (bytes.length === 0) return '';
  // If the bytes decode to a printable ASCII CID string (starts with 'b'), use it directly.
  const str = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  if (/^[a-zA-Z0-9+/=_-]+$/.test(str) && str.length > 10) return str;
  // Otherwise return as base64url (fallback; callers should store CIDs as UTF-8 bytes).
  return toBase64url(bytes);
}
