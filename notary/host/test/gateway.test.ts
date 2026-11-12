import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { AeadId, CipherSuite, KdfId, KemId } from "hpke-js";
import { gcm } from "@noble/ciphers/aes.js";
import { x25519 } from "@noble/curves/ed25519";
import { decapsulate, getKeyConfig } from "../src/ohttp-gateway.js";
import type { OhttpEnvelope, OhttpResponseEnvelope } from "../src/ohttp-gateway.js";
import { dispatch } from "../src/ohttp-router.js";
import { handleCreateJob } from "../src/handlers/jobs.js";
import { harness, job, JOB_HASH, sealed, vec } from "./helpers.js";

const SUITE = new CipherSuite({ kem: KemId.DhkemX25519HkdfSha256, kdf: KdfId.HkdfSha256, aead: AeadId.Aes256Gcm });
const GATEWAY_KEY = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const ab = (b: Uint8Array) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
const b64 = (s: string) => new Uint8Array(Buffer.from(s, "base64url"));
const body = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const unbody = (r: OhttpResponseEnvelope) => (r.body ? JSON.parse(Buffer.from(r.body, "base64url").toString("utf-8")) : undefined);

/** A client as the wallet's transport does it: HPKE to the gateway key, then decrypt the response with the exported key. */
async function viaGateway(h: Awaited<ReturnType<typeof harness>>, env: OhttpEnvelope) {
  const cfg = getKeyConfig(GATEWAY_KEY, "notary-a");
  const pk = await SUITE.kem.deserializePublicKey(ab(b64(cfg.publicKey)));
  const ctx = await SUITE.createSenderContext({ recipientPublicKey: pk });
  const ciphertext = new Uint8Array(await ctx.seal(ab(new TextEncoder().encode(JSON.stringify(env)))));
  const { envelope, encapsulateResponse } = await decapsulate(GATEWAY_KEY, { enc: Buffer.from(new Uint8Array(ctx.enc)).toString("base64url"), ciphertext: Buffer.from(ciphertext).toString("base64url") });
  expect(envelope).toEqual(env); // the host sees only the outer envelope's contents: a path and a sealed body
  const resp = await encapsulateResponse(await dispatch(envelope, h.ctx));
  const key = new Uint8Array(await ctx.export(new TextEncoder().encode("card-protocol-ohttp-response-v1"), 32));
  return JSON.parse(new TextDecoder().decode(gcm(key, b64(resp.nonce)).decrypt(b64(resp.ciphertext)))) as OhttpResponseEnvelope;
}

describe("oblivious gateway (notary_host.md §6; oblivious_transport.md §Notary Host Destination)", () => {
  it("key config exposes the X25519 gateway key and the relay target id", () => {
    expect(getKeyConfig(GATEWAY_KEY, "notary-a")).toMatchObject({ kemId: KemId.DhkemX25519HkdfSha256, publicKey: Buffer.from(x25519.getPublicKey(GATEWAY_KEY)).toString("base64url"), targetId: "notary-a" });
  });
  it("round trip: a sealed input POSTed through the gateway returns the host receipt and the enclave's sealed receipt, encrypted back to the client", async () => {
    const h = await harness({ submitInput: () => ({ input_hash: "x", receipt_sealed: "c2VhbGVk" }) });
    await handleCreateJob(h.ctx, { job, program_cid: h.programCid });
    const r = await viaGateway(h, { path: `/jobs/${JOB_HASH}/inputs`, method: "POST", body: body(sealed) });
    expect(r.status).toBe(200);
    expect(unbody(r)).toMatchObject({ receipt_sealed: "c2VhbGVk", host_receipt: { type: "notary.host_receipt.v1", job_hash: JOB_HASH } });
    expect(h.enclave.received.find((m) => m.kind === "submit_input")!["sealed_input"]).toEqual(sealed);
  });
  it("GET announcement goes through the gateway; errors come back as { error, message } with the status", async () => {
    const h = await harness();
    const r = await viaGateway(h, { path: `/jobs/${JOB_HASH}/announcement`, method: "GET" });
    expect(r.status).toBe(404);
    expect(unbody(r)).toMatchObject({ error: "NH_JOB_UNKNOWN" });
  });
  it("only the two oblivious routes are reachable through the gateway", async () => {
    const h = await harness();
    for (const e of [{ path: `/jobs/${JOB_HASH}/status`, method: "GET" }, { path: "/jobs", method: "POST" }, { path: `/jobs/${JOB_HASH}/announcement`, method: "POST" },
      { path: `/jobs/${JOB_HASH}/inputs`, method: "GET" }, { path: "/genesis", method: "POST" }, { path: "/peer", method: "POST" }, { path: "/jobs/short/inputs", method: "POST" }, { path: "/health", method: "GET" }]) {
      const r = await dispatch(e, h.ctx);
      expect(r.status, `${e.method} ${e.path}`).toBe(404);
      expect(unbody(r).error).toBe("NOT_REACHABLE");
    }
  });
  it("a non-JSON body is INPUT_MALFORMED, not a crash", async () => {
    const h = await harness(); await handleCreateJob(h.ctx, { job, program_cid: h.programCid });
    const r = await dispatch({ path: `/jobs/${JOB_HASH}/inputs`, method: "POST", body: Buffer.from("not json").toString("base64url") }, h.ctx);
    expect(r.status).toBe(400);
    expect(unbody(r).error).toBe("INPUT_MALFORMED");
  });
});

describe("direct routes (NH_DIRECT_FORBIDDEN)", () => {
  const routes = join(dirname(fileURLToPath(import.meta.url)), "..", "server", "routes", "jobs", "[hash]");
  it("the announcement and inputs route files refuse every direct request and import no handler", () => {
    for (const f of ["announcement.get.ts", "inputs.post.ts"]) {
      const src = readFileSync(join(routes, f), "utf8");
      expect(src, f).toContain("NH_DIRECT_FORBIDDEN");
      expect(src, f).toContain("setResponseStatus(event, 403)");
      expect(src, f).not.toMatch(/import\s/);
    }
  });
  it("no other route file reaches the oblivious handlers", () => {
    const all = (d: string): string[] => readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? all(p) : [p]; });
    for (const f of all(join(routes, "..", ".."))) {
      if (f.includes("announcement.get") || f.includes("inputs.post")) continue;
      expect(readFileSync(f, "utf8"), f).not.toMatch(/handleSubmitInput|handleGetAnnouncement/);
    }
  });
  void vec;
});
