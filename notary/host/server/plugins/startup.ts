/**
 * Builds the host context at startup: validates configuration, connects to each local enclave through its socket
 * (the vsock proxy in production, the simulator's socket locally), and says `hello` to learn each instance id.
 *
 * Production implementations of the chain, EAS and IPFS (Kubo) services are Phase 7 (the integration stack), so
 * they are `notImplemented` here and the host refuses to start with them unless `IPFS_PROVIDER=mock`.
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
import type { KvStore } from "../../src/kv.js";

let ctx: HostContext | undefined;
let startupError: string | undefined;

export const getCtx = (): HostContext => { if (!ctx) throw new Error("host not ready"); return ctx; };
export const isHostReady = () => ctx !== undefined;
export const getStartupError = () => startupError;

export default defineNitroPlugin(async () => {
  try {
    const config = loadConfig(process.env);
    const s = useStorage("notary");
    const kv: KvStore = {
      getItem: async <T>(k: string) => s.getItem<T>(k), setItem: async (k, v) => { await s.setItem(k, v as never); }, removeItem: async (k) => { await s.removeItem(k); },
      getKeys: async (p) => s.getKeys(p),
    };
    const mem = memoryServices();
    const post = async (url: string, body: unknown) => { await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); };
    const c = createContext({
      config, kv, ipfs: config.IPFS_PROVIDER === "mock" ? createMockIpfs() : mem.ipfs, eas: mem.eas, chain: mem.chain, submitter: mem.submitter, policies: mem.policies,
      peers: { send: async (url, body) => post(`${url.replace(/\/$/, "")}/peer`, body) }, delivery: mem.delivery, replicas: mem.replicas,
      monitor: webhookMonitor(config.ALERT_WEBHOOK_URL, post), sessions: new Map(),
    });
    for (const ep of config.ENCLAVE_ENDPOINTS) {
      const session = new EnclaveSession(ep.cid, await connectSocket(ep.address));
      attachEnclave(c, session);
      const hello = await session.call("hello", { challenge: b64uEncode(crypto.getRandomValues(new Uint8Array(32))) });
      c.instances.set(b64uEncode(sha256(Buffer.from(String(hello["inst_pubkey"]), "base64url"))), session);
      c.sessions.set(ep.cid, session);
    }
    ctx = c;
  } catch (e) { startupError = (e as Error).message; console.error(`[notary-host] startup failed: ${startupError}`); }
});
