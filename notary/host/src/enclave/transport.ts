/**
 * `EnclaveTransport` (code-plan §2.3; Q23): one interface for the vsock proxy and the simulator, because Node has
 * no native vsock; the proxy exposes a normal socket. This implementation speaks the framed protocol over a Unix or
 * TCP socket. `EnclaveSession` correlates replies by `req_id` and hands enclave-initiated requests to a handler.
 */
import net from "node:net";
import { encodeFrame, FrameReader } from "./protocol.js";
import type { Msg } from "./protocol.js";
import type { EnclaveEndpoint } from "../config.js";

export interface EnclaveTransport {
  send(msg: Msg): Promise<void>;
  onMessage(handler: (msg: Msg) => void): void;
  onClose(handler: () => void): void;
  close(): Promise<void>;
}

export function connectSocket(address: EnclaveEndpoint["address"]): Promise<EnclaveTransport> {
  return new Promise((resolve, reject) => {
    const socket = "unix" in address ? net.connect(address.unix) : net.connect(address.port, address.host);
    const reader = new FrameReader();
    let onMsg: (m: Msg) => void = () => {};
    let onClose: () => void = () => {};
    socket.once("error", reject);
    socket.on("data", (d) => { try { for (const m of reader.push(d)) onMsg(m); } catch { socket.destroy(); } });
    socket.on("close", () => onClose());
    socket.once("connect", () => {
      socket.off("error", reject);
      resolve({
        send: (msg) => new Promise((res, rej) => socket.write(encodeFrame(msg), (e) => (e ? rej(e) : res()))),
        onMessage: (h) => { onMsg = h; },
        onClose: (h) => { onClose = h; },
        close: () => new Promise((res) => { socket.end(() => res()); }),
      });
    });
  });
}

export class EnclaveError extends Error {
  constructor(public readonly code: string, message: string) { super(`${code}: ${message}`); }
}

type Pending = { resolve: (m: Msg) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> };

export class EnclaveSession {
  readonly #pending = new Map<string, Pending>();
  #seq = 0;
  #requestHandler: (m: Msg) => void = () => {};
  closed = false;

  constructor(readonly cid: string, readonly transport: EnclaveTransport, readonly timeoutMs = 30_000) {
    transport.onMessage((m) => {
      const p = this.#pending.get(m.req_id);
      if (p && !isEnclaveRequest(m.kind)) { clearTimeout(p.timer); this.#pending.delete(m.req_id); p.resolve(m); return; }
      this.#requestHandler(m);
    });
    transport.onClose(() => { this.closed = true; for (const [id, p] of this.#pending) { clearTimeout(p.timer); p.reject(new EnclaveError("NH_ENCLAVE_UNAVAILABLE", "enclave connection closed")); this.#pending.delete(id); } });
  }

  /** Called for enclave-initiated messages (`fetch`, `publish`, `announce`, ...). */
  onEnclaveRequest(h: (m: Msg) => void): void { this.#requestHandler = h; }

  /** Sends a message and waits for its reply. An `error` reply is thrown as `EnclaveError` with the enclave's code. */
  async call(kind: string, fields: Record<string, unknown> = {}): Promise<Msg> {
    if (this.closed) throw new EnclaveError("NH_ENCLAVE_UNAVAILABLE", "enclave connection closed");
    const req_id = `${this.cid}-${++this.#seq}`;
    const reply = new Promise<Msg>((resolve, reject) => {
      const timer = setTimeout(() => { this.#pending.delete(req_id); reject(new EnclaveError("NH_ENCLAVE_UNAVAILABLE", `no reply to ${kind} within ${this.timeoutMs} ms`)); }, this.timeoutMs);
      this.#pending.set(req_id, { resolve, reject, timer });
    });
    await this.transport.send({ ...fields, kind, req_id });
    const r = await reply;
    if (r.kind === "error") throw new EnclaveError(String(r["code"] ?? "ENCLAVE_ERROR"), String(r["message"] ?? "enclave error"));
    return r;
  }

  /** Sends a message that has no direct reply (for example `fetch_result`, `anchor_receipt`, `chain_result`). */
  async notify(kind: string, req_id: string, fields: Record<string, unknown> = {}): Promise<void> {
    await this.transport.send({ ...fields, kind, req_id });
  }
}

const ENCLAVE_KINDS = new Set(["fetch", "publish", "announce", "chain_submit", "eas_anchor", "deliver", "peer_send", "need_replica", "alert"]);
const isEnclaveRequest = (k: string) => ENCLAVE_KINDS.has(k);
