/**
 * Builds the host context at startup: validates configuration, connects to each local enclave through its socket
 * (the vsock proxy in production, the simulator's socket locally), and says `hello` to learn each instance id.
 *
 * Two stacks start (`src/providers.ts`): the simulated one (`CHAIN_PROVIDER=sim`), which says so in a warning, and the
 * production one (`CHAIN_PROVIDER=rpc` with Kubo; `src/chain/rpc.ts`). Replica starts (`need_replica`) are still the in-memory
 * recorder in both: nothing starts an enclave for the host yet, so standby enclaves must be started in advance.
 */
import { sha256 } from "@noble/hashes/sha256";
import { b64uEncode } from "@membership-card-protocol/wallet-sdk/notary-types";
import { loadConfig } from "../../src/config.js";
import { createContext } from "../../src/context.js";
import type { HostContext } from "../../src/context.js";
import { connectSocket, EnclaveSession } from "../../src/enclave/transport.js";
import { attachEnclave } from "../../src/handlers/enclave-requests.js";
import { createMockIpfs } from "../../src/ipfs/index.js";
import { webhookMonitor } from "../../src/monitoring/index.js";
import { memoryServices } from "../../src/testing.js";
import { simChain } from "../../src/sim/index.js";
import { rpcChain } from "../../src/chain/rpc.js";
import { kuboIpfs } from "../../src/ipfs/kubo.js";
import { policyReader } from "../../src/chain/policies.js";
import { walletDelivery } from "../../src/delivery/wallet.js";
import { providerProblems, simulatedComponents, chainIdProblem } from "../../src/providers.js";
import { startSchedulers } from "../../src/schedulers/index.js";
import type { KvStore } from "../../src/kv.js";
import redisDriver from "unstorage/drivers/redis";
import memoryDriver from "unstorage/drivers/memory";

let ctx: HostContext | undefined;
let startupError: string | undefined;

export const getCtx = (): HostContext => { if (!ctx) throw new Error("host not ready"); return ctx; };
export const isHostReady = () => ctx !== undefined;
export const getStartupError = () => startupError;

export default defineNitroPlugin(async () => {
  try {
    const config = loadConfig(process.env);
    // 5.7: never fall back to the in-memory test services (they would fake anchors and pin nothing)
    const refused = providerProblems(config);
    if (refused.length > 0) throw new Error(`refusing to start: ${refused.join(" ")}`);
    const simulated = simulatedComponents(config);
    if (simulated.length > 0) console.warn(`[notary-host] WARNING: simulated components, not for production: ${simulated.join("; ")}`);
    const storage = useStorage();
    storage.mount("notary", config.EXTERNAL_KV_URL.startsWith("memory:") ? memoryDriver() : redisDriver({ url: config.EXTERNAL_KV_URL }));
    const s = useStorage("notary");
    const kv: KvStore = {
      getItem: async <T>(k: string) => s.getItem<T>(k), setItem: async (k, v) => { await s.setItem(k, v as never); }, removeItem: async (k) => { await s.removeItem(k); },
      getKeys: async (p) => s.getKeys(p),
    };
    const mem = memoryServices();
    // the chain, EAS, registry, IPFS and delivery services: simulated, or the production clients (providerProblems() has checked the pairing)
    const services = (() => {
      if (config.CHAIN_PROVIDER === "sim") {
        const sim = simChain(config.SIM_CHAIN_URL!);
        return { ipfs: config.IPFS_PROVIDER === "sim" ? sim.ipfs : createMockIpfs(), eas: sim.eas, chain: sim.chain, submitter: sim.submitter, policies: sim.policies, delivery: sim.delivery, feed: sim.feed, gas: undefined, chainId: undefined };
      }
      const ipfs = kuboIpfs(config.KUBO_API_URL!);
      const rpc = rpcChain({ rpcUrl: config.ARBITRUM_RPC_URL, logicContract: config.REGISTRY_CONTRACT_ADDRESS, storageContract: config.REGISTRY_STORAGE_ADDRESS!,
        gasWalletKey: config.NOTARY_GAS_WALLET_PRIVATE_KEY, easContract: config.EAS_CONTRACT_ADDRESS, easSchemaUid: config.NOTARY_EAS_SCHEMA_UID });
      return { ipfs, eas: rpc.eas!, chain: rpc.chain, submitter: rpc.submitter, policies: policyReader(ipfs), delivery: walletDelivery(config.NOTARY_DELIVERY_URL!), feed: rpc.feed, gas: rpc.gas, chainId: rpc.chainId };
    })();
    // the RPC must be the chain this host was configured for: a wrong endpoint is caught at start, not by a job
    if (services.chainId) {
      const actual = await services.chainId();
      const wrong = chainIdProblem(actual, config.EXPECTED_CHAIN_ID);
      if (wrong) throw new Error(`refusing to start: ${wrong}`);
    }
    const post = async (url: string, body: unknown) => { await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); };
    const c = createContext({
      config, kv, ipfs: services.ipfs,
      eas: services.eas, chain: services.chain, submitter: services.submitter, policies: services.policies,
      peers: {
        send: async (url, body) => post(`${url.replace(/\/$/, "")}/peer`, body),
        request: async (url, body) => { const r = await fetch(`${url.replace(/\/$/, "")}/peer`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); return r.ok ? r.json() : {}; },
      },
      delivery: services.delivery, replicas: mem.replicas, ...(services.gas ? { gas: services.gas } : {}),
      monitor: webhookMonitor(config.ALERT_WEBHOOK_URL, post), sessions: new Map(), gateOnSnapshots: true,
    });
    for (const ep of config.ENCLAVE_ENDPOINTS) {
      // the enclave may still be starting (compose starts services together): retry for up to 60 s
      let transport;
      for (let i = 0; ; i++) {
        try { transport = await connectSocket(ep.address); break; }
        catch (e) { if (i >= 59) throw e; await new Promise((r) => setTimeout(r, 1000)); }
      }
      const session = new EnclaveSession(ep.cid, transport);
      attachEnclave(c, session);
      const hello = await session.call("hello", { challenge: b64uEncode(crypto.getRandomValues(new Uint8Array(32))) });
      const instance = b64uEncode(sha256(Buffer.from(String(hello["inst_pubkey"]), "base64url")));
      c.instances.set(instance, session);
      c.instanceKeys.set(instance, String(hello["inst_pubkey"]));
      c.sessions.set(ep.cid, session);
    }
    await c.cards.load();
    ctx = c;
    // the chain feed: the simulated chain's, or the RPC feed in production
    startSchedulers(c, services.feed, { snapshotSeconds: config.SNAPSHOT_REFRESH_SECONDS, ...(services.gas ? { gasLowWei: config.GAS_BALANCE_LOW_WEI } : {}) });
  } catch (e) { startupError = (e as Error).message; console.error(`[notary-host] startup failed: ${startupError}`); }
});
