/**
 * A scripted stand-in for the enclave, for host tests (code-plan §7.1: "vitest with a mock enclave").
 *
 * It is a test double only: it holds no job keys, runs no program and checks no input. It proves the host's
 * plumbing (what the host sends, stores, forwards, relays and refuses), not any property of the real enclave, which
 * only the runtime tests (step 5.3) and the integration stack can show. Replies are canned or scripted.
 */
import type { EnclaveTransport } from "./transport.js";
import type { Msg } from "./protocol.js";

export interface MockScript {
  /** Reply to `create_job`: default `job_keyed`. Return `{ reject: "ADM_..." }` for `job_rejected`. */
  createJob?(m: Msg): { reject: string } | { epoch: number; job_public_key: string; attestation: string; announcement?: unknown; extra?: Msg[] };
  submitInput?(m: Msg): { error: string } | { input_hash: string; receipt_sealed: string };
  /** Reply to the last `close_chunk`: default `job_closed` with a small notarization. */
  closeChunk?(m: Msg): { error: string } | { notarization: unknown };
}

export class MockEnclave implements EnclaveTransport {
  readonly received: Msg[] = [];
  #onMsg: (m: Msg) => void = () => {};
  #onClose: () => void = () => {};
  /** When set, replies are withheld (simulates a hung enclave). */
  silent = false;

  constructor(public readonly script: MockScript = {}) {}

  onMessage(h: (m: Msg) => void) { this.#onMsg = h; }
  onClose(h: () => void) { this.#onClose = h; }
  async close() { this.#onClose(); }
  /** Enclave-initiated message to the host (`publish`, `announce`, `eas_anchor`, ...). */
  emit(m: Msg) { queueMicrotask(() => this.#onMsg(m)); }

  async send(m: Msg): Promise<void> {
    this.received.push(m);
    if (this.silent) return;
    const reply = (r: Record<string, unknown>) => queueMicrotask(() => this.#onMsg({ ...r, req_id: m.req_id } as Msg));
    switch (m.kind) {
      case "hello": return reply({ kind: "hello_ack", inst_pubkey: "TU9DS19JTlNU", attestation: "TU9DS19BVFQ" });
      case "chain_headers": return reply({ kind: "chain_ack", newest: ((m["headers"] as { number: number }[]) ?? []).at(-1)?.number ?? 0 });
      case "policy_snapshot": return reply({ kind: "snapshot_ack" });
      case "create_job": {
        const r = this.script.createJob?.(m) ?? { epoch: 0, job_public_key: "TU9DS19KT0JfS0VZ", attestation: "TU9DS19BVFQ" };
        if ("reject" in r) return reply({ kind: "job_rejected", code: r.reject });
        reply({ kind: "job_keyed", epoch: r.epoch, job_public_key: r.job_public_key, attestation: r.attestation });
        if (r.announcement) this.emit({ kind: "announce", req_id: `mock-ann-${this.received.length}`, announcement: r.announcement });
        for (const e of r.extra ?? []) this.emit(e);
        return;
      }
      case "submit_input": {
        const r = this.script.submitInput?.(m) ?? { input_hash: "MOCK_INPUT_HASH", receipt_sealed: "TU9DS19SRUNFSVBU" };
        return "error" in r ? reply({ kind: "error", code: r.error, message: "mock enclave rejected the input" }) : reply({ kind: "input_result", ...r });
      }
      case "genesis": return reply({ kind: "genesis_ready", id_pubkey: "TU9DS19JRA", chain_pubkey: "TU9DS19DSEFJTg", attestation: "TU9DS19BVFQ", notary_card: "cd".repeat(32) });
      case "countersign_notary_card": return reply({ kind: "countersigned", offer: (m as { offer?: unknown }).offer });
      case "abort_job": return reply({ kind: "job_log_record", record: {} });
      case "close_chunk": {
        if (m["last"] !== true) return;
        const r = this.script.closeChunk?.(m) ?? { notarization: { type: "notary.notarization.v1", mock: true } };
        return "error" in r ? reply({ kind: "error", code: r.error, message: "mock enclave refused the close" }) : reply({ kind: "job_closed", notarization: r.notarization, record: null, outputs: [] });
      }
      default: return; // fetch_result, anchor_receipt, chain_result, peer_message, policy_updates: no reply
    }
  }
}
