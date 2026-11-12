import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { b64uDecode, b64uEncode } from "@membership-card-protocol/verifier/notary";
import { hpkeSuite } from "../src/hpke.ts";

const V = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "vectors", "xwing");
const load = (f: string) => JSON.parse(readFileSync(join(V, f), "utf8"));
const u = (c: Record<string, string>, k: string) => b64uDecode(c[k]!);
const te = new TextEncoder();

// CP9 checkpoint 1: X-Wing draft-06 interop. Rust side: notary/runtime/crates/notary-crypto/tests/xwing_interop.rs
describe("X-Wing draft-06 HPKE interop (TypeScript side)", () => {
  it("opens the Rust-produced vectors (Rust → JS) and exports the same secret", async () => {
    const suite = hpkeSuite();
    const v = load("rust_vectors.json");
    expect(v.cases.length).toBeGreaterThanOrEqual(3);
    for (const c of v.cases) {
      const sk = await suite.kem.deserializePrivateKey(u(c, "sk_b64u").buffer as ArrayBuffer);
      const rctx = await suite.createRecipientContext({ recipientKey: sk, enc: u(c, "enc_b64u"), info: u(c, "info_b64u") });
      const pt = new Uint8Array(await rctx.open(u(c, "ct_b64u"), u(c, "aad_b64u")));
      expect(b64uEncode(pt), c.id).toBe(c.pt_b64u);
      expect(b64uEncode(new Uint8Array(await rctx.export(te.encode(c.export_context), 32))), c.id).toBe(c.exported_b64u);
      // the public key Rust derived from the same secret matches what JS sends to
      const pk = await suite.kem.deserializePublicKey(u(c, "pk_b64u").buffer as ArrayBuffer);
      const sender = await suite.createSenderContext({ recipientPublicKey: pk, info: u(c, "info_b64u"), ekm: u(c, "ekm_b64u") });
      expect(b64uEncode(new Uint8Array(sender.enc)), c.id).toBe(c.enc_b64u);
      expect(b64uEncode(new Uint8Array(await sender.seal(u(c, "pt_b64u"), u(c, "aad_b64u")))), c.id).toBe(c.ct_b64u);
    }
  });

  it("opens its own committed vectors and rejects a wrong aad (JS)", async () => {
    const suite = hpkeSuite();
    for (const c of load("js_vectors.json").cases) {
      const sk = await suite.kem.deserializePrivateKey(u(c, "sk_b64u").buffer as ArrayBuffer);
      const rctx = await suite.createRecipientContext({ recipientKey: sk, enc: u(c, "enc_b64u"), info: u(c, "info_b64u") });
      expect(b64uEncode(new Uint8Array(await rctx.open(u(c, "ct_b64u"), u(c, "aad_b64u"))))).toBe(c.pt_b64u);
      const r2 = await suite.createRecipientContext({ recipientKey: sk, enc: u(c, "enc_b64u"), info: u(c, "info_b64u") });
      await expect(r2.open(u(c, "ct_b64u"), te.encode("wrong"))).rejects.toThrow();
    }
  });
});
