/** X-Wing draft-06 HPKE suite and the §24 info/aad construction (shared by the generator and tests). */
import { CipherSuite, HkdfSha256 } from "@hpke/core";
import { Chacha20Poly1305 } from "@hpke/chacha20poly1305";
import { XWing } from "@hpke/hybridkem-x-wing";
import { b64uEncode, canonicalNotary } from "@membership-card-protocol/verifier/notary";

const te = new TextEncoder();

export const hpkeSuite = () => new CipherSuite({ kem: new XWing(), kdf: new HkdfSha256(), aead: new Chacha20Poly1305() });

/** `info` and `aad` exactly as protocol-objects.md §24 defines them. */
export function sealedInputInfoAad(jobHash: Uint8Array, epoch: number) {
  const epochBytes = new Uint8Array(8); new DataView(epochBytes.buffer).setBigUint64(0, BigInt(epoch), false);
  const info = Uint8Array.from([...te.encode("card-notary-input-v1"), 0, ...jobHash, ...epochBytes, ...te.encode("x-wing-draft-06")]);
  const aad = canonicalNotary({ epoch, job_hash: b64uEncode(jobHash), kem: "x-wing-draft-06", type: "notary.sealed_input.v1" });
  return { info, aad };
}
export const RECEIPT_EXPORT_CONTEXT = "card-notary-receipt-v1";

