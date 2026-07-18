/**
 * CID reconciliation scheduled task (spec §3.5).
 *
 * Runs every 6 hours. Reads all CardRegistered and CardHeadUpdated events
 * from the Arbitrum One registry contract since the last processed block,
 * then ensures each CID is pinned in Filebase via their Pinning API.
 *
 * Filebase Pinning API (IPFS Pinning Services API compatible):
 *   POST https://api.filebase.io/v1/ipfs/pins
 *   Authorization: Bearer base64(KEY:SECRET)
 *
 * The last processed block is checkpointed in the KV store under
 * press:reconcile:last_block so each run only processes new events.
 */

import { createPublicClient, http, parseAbi, type Hex, decodeEventLog } from 'viem';
import { arbitrum } from 'viem/chains';
import { loadConfig } from '../../src/config.js';
import { kvKeys } from '../../src/kv.js';
import { createNitroKvStore } from '../utils/kv.js';

const RECONCILE_EVENTS_ABI = parseAbi([
  'event CardRegistered(bytes32 indexed card_address, bytes32 indexed policy_address, bytes32 press_address, bytes initial_log_cid, uint64 timestamp)',
  'event CardHeadUpdated(bytes32 indexed card_address, bytes prev_log_cid, bytes new_log_cid, bytes32 press_address, uint64 timestamp)',
]);

const FILEBASE_PINNING_API = 'https://api.filebase.io/v1/ipfs/pins';
// Process events in batches of 2000 blocks to stay within RPC limits.
const BLOCK_BATCH_SIZE = 2000n;

export default defineTask({
  meta: {
    name: 'reconcile-cids',
    description: 'Pin all card CIDs registered in the storage contract via Filebase',
  },
  async run() {
    const config = loadConfig();

    // The Filebase Pinning API is Filebase-specific — there's no equivalent
    // reconciliation mechanism for the other IpfsPinningProvider
    // implementations (kubo/mock, used for local/integration testing), so
    // this task is a no-op unless Filebase is the active provider.
    if (config.IPFS_PROVIDER !== 'filebase') {
      console.info(
        `[reconcile] Skipped — IPFS_PROVIDER is "${config.IPFS_PROVIDER}", not "filebase".`
      );
      return { result: 'skipped-non-filebase-provider' };
    }

    const kv = createNitroKvStore();

    const client = createPublicClient({
      chain: arbitrum,
      transport: http(config.ARBITRUM_RPC_URL),
    });

    const contractAddress = config.REGISTRY_CONTRACT_ADDRESS as Hex;
    const latestBlock = await client.getBlockNumber();

    // Read checkpoint; default to current block - 1 on first run (no backfill).
    const checkpointKey = kvKeys.reconcileLastBlock();
    const storedBlock = await kv.getItem<number>(checkpointKey);
    const fromBlock = storedBlock != null ? BigInt(storedBlock) + 1n : latestBlock;

    if (fromBlock > latestBlock) {
      console.info('[reconcile] No new blocks to process.');
      return { result: 'up-to-date' };
    }

    const pinned: string[] = [];
    const failed: string[] = [];
    let cursor = fromBlock;

    const pinningAuth = Buffer.from(
      `${config.FILEBASE_KEY}:${config.FILEBASE_SECRET}`
    ).toString('base64');

    while (cursor <= latestBlock) {
      const toBlock =
        cursor + BLOCK_BATCH_SIZE - 1n < latestBlock
          ? cursor + BLOCK_BATCH_SIZE - 1n
          : latestBlock;

      // Fetch CardRegistered events.
      const registered = await client.getLogs({
        address: contractAddress,
        event: RECONCILE_EVENTS_ABI[0],
        fromBlock: cursor,
        toBlock,
      });

      // Fetch CardHeadUpdated events.
      const updated = await client.getLogs({
        address: contractAddress,
        event: RECONCILE_EVENTS_ABI[1],
        fromBlock: cursor,
        toBlock,
      });

      // Collect CIDs from both event types.
      const cids = new Set<string>();
      for (const log of registered) {
        const decoded = decodeEventLog({ abi: RECONCILE_EVENTS_ABI, data: log.data, topics: log.topics });
        const args = decoded.args as { initial_log_cid?: Uint8Array };
        if (args.initial_log_cid) {
          const cid = new TextDecoder().decode(args.initial_log_cid).replace(/\0/g, '');
          if (cid) cids.add(cid);
        }
      }
      for (const log of updated) {
        const decoded = decodeEventLog({ abi: RECONCILE_EVENTS_ABI, data: log.data, topics: log.topics });
        const args = decoded.args as { new_log_cid?: Uint8Array };
        if (args.new_log_cid) {
          const cid = new TextDecoder().decode(args.new_log_cid).replace(/\0/g, '');
          if (cid) cids.add(cid);
        }
      }

      // Pin each CID via Filebase Pinning API (idempotent).
      for (const cid of cids) {
        try {
          const res = await fetch(FILEBASE_PINNING_API, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${pinningAuth}`,
            },
            body: JSON.stringify({ cid, name: `card-protocol-${cid.slice(0, 16)}` }),
          });
          if (res.ok || res.status === 409 /* already pinned */) {
            pinned.push(cid);
          } else {
            const body = await res.text();
            console.warn(`[reconcile] Filebase pin failed for ${cid}: HTTP ${res.status} — ${body}`);
            failed.push(cid);
          }
        } catch (err) {
          console.warn(`[reconcile] Filebase pin error for ${cid}: ${String(err)}`);
          failed.push(cid);
        }
      }

      cursor = toBlock + 1n;
    }

    // Advance checkpoint only on full success to avoid skipping blocks on partial failure.
    if (failed.length === 0) {
      await kv.setItem(checkpointKey, Number(latestBlock));
    }

    console.info(
      `[reconcile] Done. Blocks ${fromBlock}–${latestBlock}. ` +
        `Pinned: ${pinned.length}, Failed: ${failed.length}.`
    );

    if (failed.length > 0) {
      console.error(`[reconcile] Failed CIDs: ${failed.join(', ')}`);
    }

    return {
      result: 'done',
      blocks_processed: Number(latestBlock - fromBlock + 1n),
      pinned: pinned.length,
      failed: failed.length,
    };
  },
});
