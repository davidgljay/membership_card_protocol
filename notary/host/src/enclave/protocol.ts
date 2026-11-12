/**
 * Host–enclave protocol (notary_runtime.md §9). Frames are a 4-byte big-endian length plus RFC 8785 JSON, at most
 * 16 MiB; every message has `kind` and `req_id`. Everything from the enclave is checked by the host only for what
 * the host is responsible for (availability and accountability); the host never sees plaintext inputs or keys.
 */
import { canonicalNotary } from "@membership-card-protocol/wallet-sdk/notary-types";

export const MAX_FRAME = 16 * 1024 * 1024;

export type Msg = { kind: string; req_id: string; [field: string]: unknown };

/** Host → enclave kinds (runtime §9). */
export const HOST_TO_ENCLAVE = ["hello", "chain_headers", "fetch_result", "policy_snapshot", "policy_updates", "genesis", "countersign_notary_card",
  "create_job", "submit_input", "close_chunk", "anchor_receipt", "chain_result", "peer_message", "abort_job"] as const;
/** Enclave → host kinds (runtime §9). */
export const ENCLAVE_TO_HOST = ["fetch", "publish", "announce", "chain_submit", "eas_anchor", "deliver", "peer_send", "need_replica", "alert"] as const;
/** Replies to host calls. */
export const REPLY_KINDS = ["hello_ack", "chain_ack", "snapshot_ack", "genesis_ready", "countersigned", "job_keyed", "job_rejected", "input_result",
  "job_closed", "job_log_record", "error"] as const;

export function encodeFrame(msg: Msg): Uint8Array {
  const body = canonicalNotary(msg);
  if (body.length > MAX_FRAME) throw new Error("frame exceeds 16 MiB");
  const out = new Uint8Array(4 + body.length);
  new DataView(out.buffer).setUint32(0, body.length, false);
  out.set(body, 4);
  return out;
}

/** Incremental frame reader: feed chunks, get whole messages. Throws on an oversize or malformed frame. */
export class FrameReader {
  #buf = new Uint8Array(0);
  push(chunk: Uint8Array): Msg[] {
    const joined = new Uint8Array(this.#buf.length + chunk.length);
    joined.set(this.#buf); joined.set(chunk, this.#buf.length);
    this.#buf = joined;
    const out: Msg[] = [];
    for (;;) {
      if (this.#buf.length < 4) break;
      const len = new DataView(this.#buf.buffer, this.#buf.byteOffset).getUint32(0, false);
      if (len > MAX_FRAME) throw new Error("frame exceeds 16 MiB");
      if (this.#buf.length < 4 + len) break;
      const msg = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(this.#buf.subarray(4, 4 + len))) as Msg;
      if (typeof msg.kind !== "string" || typeof msg.req_id !== "string") throw new Error("frame is missing kind or req_id");
      out.push(msg);
      this.#buf = this.#buf.slice(4 + len);
    }
    return out;
  }
}
