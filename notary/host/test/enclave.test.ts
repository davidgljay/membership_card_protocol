import { describe, it, expect } from "vitest";
import net from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeFrame, FrameReader, MAX_FRAME } from "../src/enclave/protocol.js";
import { connectSocket, EnclaveError, EnclaveSession } from "../src/enclave/transport.js";
import type { Msg } from "../src/enclave/protocol.js";
import { MockEnclave } from "../src/enclave/mock.js";

describe("framing (notary_runtime.md §8–§9)", () => {
  const m: Msg = { kind: "hello", req_id: "1", challenge: "abc" };
  it("round-trips a frame: 4-byte big-endian length plus canonical JSON", () => {
    const f = encodeFrame(m);
    expect(new DataView(f.buffer).getUint32(0, false)).toBe(f.length - 4);
    expect(new TextDecoder().decode(f.subarray(4))).toBe('{"challenge":"abc","kind":"hello","req_id":"1"}');
    expect(new FrameReader().push(f)).toEqual([m]);
  });
  it("reassembles frames split at arbitrary points and handles several per chunk", () => {
    const a = encodeFrame(m), b = encodeFrame({ ...m, req_id: "2" });
    const all = Uint8Array.from([...a, ...b]);
    const r = new FrameReader();
    const out: Msg[] = [];
    for (let i = 0; i < all.length; i += 3) out.push(...r.push(all.subarray(i, i + 3)));
    expect(out.map((x) => x.req_id)).toEqual(["1", "2"]);
  });
  it("rejects oversize and malformed frames", () => {
    const big = new Uint8Array(4); new DataView(big.buffer).setUint32(0, MAX_FRAME + 1, false);
    expect(() => new FrameReader().push(big)).toThrow(/16 MiB/);
    const noKind = encodeFrame({ kind: "x", req_id: "1" });
    const text = new TextDecoder().decode(noKind.subarray(4)).replace('"kind":"x",', "");
    const body = new TextEncoder().encode(text); const f = new Uint8Array(4 + body.length); new DataView(f.buffer).setUint32(0, body.length, false); f.set(body, 4);
    expect(() => new FrameReader().push(f)).toThrow(/kind or req_id/);
    expect(() => encodeFrame({ kind: "x", req_id: "1", f: 1.5 })).toThrow();
  });
});

describe("EnclaveSession over a real socket (the vsock proxy and the simulator speak the same thing)", () => {
  function server(onMsg: (m: Msg, write: (m: Msg) => void) => void) {
    const dir = mkdtempSync(join(tmpdir(), "enc-")); const path = join(dir, "e.sock");
    const srv = net.createServer((s) => { const r = new FrameReader(); s.on("data", (d) => { for (const m of r.push(d)) onMsg(m, (x) => s.write(encodeFrame(x))); }); });
    return new Promise<{ path: string; close: () => void; srv: net.Server }>((res) => srv.listen(path, () => res({ path, srv, close: () => srv.close() })));
  }
  it("correlates replies by req_id and routes enclave-initiated messages to the handler", async () => {
    const s = await server((m, w) => { if (m.kind === "hello") { w({ kind: "fetch", req_id: "e-1", what: "ipfs:x" }); w({ kind: "hello_ack", req_id: m.req_id, inst_pubkey: "AA" }); } });
    const t = await connectSocket({ unix: s.path });
    const session = new EnclaveSession("c", t, 1000);
    const asked: Msg[] = [];
    session.onEnclaveRequest((m) => asked.push(m));
    const r = await session.call("hello", { challenge: "c" });
    expect(r).toMatchObject({ kind: "hello_ack", inst_pubkey: "AA" });
    expect(asked[0]).toMatchObject({ kind: "fetch", what: "ipfs:x" });
    await t.close(); s.close();
  });
  it("an error reply becomes an EnclaveError with the enclave's code", async () => {
    const s = await server((m, w) => w({ kind: "error", req_id: m.req_id, code: "ADM_TOO_LARGE", message: "x" }));
    const session = new EnclaveSession("c", await connectSocket({ unix: s.path }), 1000);
    await expect(session.call("create_job")).rejects.toMatchObject({ code: "ADM_TOO_LARGE" });
    s.close();
  });
  it("a silent enclave times out, and a closed connection fails pending and later calls with NH_ENCLAVE_UNAVAILABLE", async () => {
    const s = await server(() => {});
    const session = new EnclaveSession("c", await connectSocket({ unix: s.path }), 50);
    await expect(session.call("hello")).rejects.toMatchObject({ code: "NH_ENCLAVE_UNAVAILABLE" });
    const pending = session.call("hello"); s.srv.close(); await session.transport.close();
    await expect(pending).rejects.toBeInstanceOf(EnclaveError);
    await expect(session.call("hello")).rejects.toMatchObject({ code: "NH_ENCLAVE_UNAVAILABLE" });
  });
  it("the mock enclave replies like the real message table for hello and create_job", async () => {
    const e = new MockEnclave();
    const session = new EnclaveSession("m", e, 100);
    expect((await session.call("hello", { challenge: "x" })).kind).toBe("hello_ack");
    expect((await session.call("create_job", {})).kind).toBe("job_keyed");
  });
});
