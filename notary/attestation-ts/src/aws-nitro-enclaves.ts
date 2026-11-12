/**
 * AWS Nitro Enclaves attestation platform module: steps V1–V5 of algorithm V.
 *
 * Implements: notary_lifecycle.md A.1 steps 1–5; notary_runtime.md §5 (`AttestationVerifier`).
 * G5: with `notary-attest::aws` (Rust) and `notary/deploy`, the only place that parses the AWS format.
 * The Rust twin is notary/runtime/crates/notary-attest/src/aws.rs; both judge notary/vectors/attestation/cases.json.
 *
 * Document: COSE_Sign1 = Tag(18, [protected bstr({1: -35}), {}, payload bstr, signature bstr(96)]);
 * payload = { module_id, digest "SHA384", timestamp (ms), pcrs, certificate, cabundle, public_key?, user_data?, nonce? }.
 * The chain is cabundle (root first) then the leaf `certificate`.
 *
 * Chain rules (V4): signature at every link; every certificate valid at the document's timestamp; issuer
 * name = parent's subject name (DER-equal); issuers are CAs (basicConstraints), honour pathLenConstraint and
 * allow keyCertSign if keyUsage is present; the leaf is not a CA; unknown critical extensions are rejected;
 * ECDSA P-384 with SHA-384 only. No WebCrypto is used (the wallet runs on React Native).
 */
import { p384 } from "@noble/curves/p384";
import { AsnConvert } from "@peculiar/asn1-schema";
import { BasicConstraints, Certificate, KeyUsage, KeyUsageFlags } from "@peculiar/asn1-x509";
import type { AttestationVerifier, EnvelopeFailureCode } from "@membership-card-protocol/verifier/notary";
import { CborMap, CborError, decodeCbor, encodeSigStructure } from "./cbor.js";
import type { CborValue } from "./cbor.js";

/** DER of the AWS Nitro Enclaves root certificate (G1); SHA-256 641A0321…BB5B, as documented by AWS. */
export const AWS_NITRO_ROOT_G1_DER_B64 = "MIICETCCAZagAwIBAgIRAPkxdWgbkK/hHUbMtOTn+FYwCgYIKoZIzj0EAwMwSTELMAkGA1UEBhMCVVMxDzANBgNVBAoMBkFtYXpvbjEMMAoGA1UECwwDQVdTMRswGQYDVQQDDBJhd3Mubml0cm8tZW5jbGF2ZXMwHhcNMTkxMDI4MTMyODA1WhcNNDkxMDI4MTQyODA1WjBJMQswCQYDVQQGEwJVUzEPMA0GA1UECgwGQW1hem9uMQwwCgYDVQQLDANBV1MxGzAZBgNVBAMMEmF3cy5uaXRyby1lbmNsYXZlczB2MBAGByqGSM49AgEGBSuBBAAiA2IABPwCVOumCMHzaHDimtqQvkY4MpJzbolL//Zy2YlES1BR5TSksfbb48C8WBoyt7F2Bw7eEtaaP+ohG2bnUs990d0JX28TcPQXCEPZ3BABIeTPYwEoCWZEh8l5YoQwTcU/9KNCMEAwDwYDVR0TAQH/BAUwAwEB/zAdBgNVHQ4EFgQUkCW1DdkFR+eWw5b6cp3PmanfS5YwDgYDVR0PAQH/BAQDAgGGMAoGCCqGSM49BAMDA2kAMGYCMQCjfy+Rocm9Xue4YnwWmNJVA44fA0P5W2OpYow9OYCVRaEevL8uO1XYru5xtMPWrfMCMQCi85sWBbJwKKXdS6BptQFuZbT73o/gBh1qUxl/nNr12UO8Yfwr6wPLb+6NIwLz3/Y=";

export function awsNitroRootG1Der(): Uint8Array {
  return Uint8Array.from(atob(AWS_NITRO_ROOT_G1_DER_B64), (c) => c.charCodeAt(0));
}

type Fail = EnvelopeFailureCode;
class Reject extends Error { constructor(public readonly code: Fail) { super(code); } }
const reject = (c: Fail): never => { throw new Reject(c); };

const MAX_DOC = 64 * 1024, MAX_FIELD = 1024;
const OID_ECDSA_SHA384 = "1.2.840.10045.4.3.3", OID_EC_PUBLIC_KEY = "1.2.840.10045.2.1";
const OID_BASIC_CONSTRAINTS = "2.5.29.19", OID_KEY_USAGE = "2.5.29.15";
const KNOWN_CRITICAL = new Set([OID_BASIC_CONSTRAINTS, OID_KEY_USAGE, "2.5.29.37", "2.5.29.14"]);

const isBytes = (v: CborValue | undefined, max: number): v is Uint8Array => v instanceof Uint8Array && v.length > 0 && v.length <= max;
const mapOf = (v: CborValue | undefined): CborMap => (v instanceof CborMap ? v : reject("ATT_MALFORMED"));
const noDuplicateKeys = (m: CborMap) => {
  const seen = new Set<string>();
  for (const [k] of m.pairs) { const id = `${typeof k}:${String(k)}`; if (seen.has(id)) reject("ATT_MALFORMED"); seen.add(id); }
};
const field = (m: CborMap, key: string): CborValue | undefined => m.pairs.find(([k]) => k === key)?.[1];
const optBytes = (m: CborMap, key: string): Uint8Array | undefined => {
  const v = field(m, key);
  if (v === undefined || v === null) return undefined;
  return isBytes(v, MAX_FIELD) ? v : reject("ATT_MALFORMED");
};
const equal = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);

// ---- DER walking: raw sub-TLVs of a certificate (the TBS bytes and the Names must be byte-exact) ----
interface Tlv { tag: number; start: number; hdr: number; len: number }
function tlv(b: Uint8Array, at: number): Tlv {
  if (at + 2 > b.length) reject("ATT_CHAIN_INVALID");
  const tag = b[at]!;
  let len = b[at + 1]!, hdr = 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    if (n < 1 || n > 3 || at + 2 + n > b.length) reject("ATT_CHAIN_INVALID");
    len = 0;
    for (let i = 0; i < n; i++) len = (len << 8) | b[at + 2 + i]!;
    hdr = 2 + n;
  }
  if (at + hdr + len > b.length) reject("ATT_CHAIN_INVALID");
  return { tag, start: at, hdr, len };
}
const children = (b: Uint8Array, t: Tlv): Tlv[] => {
  const out: Tlv[] = [];
  for (let p = t.start + t.hdr; p < t.start + t.hdr + t.len;) { const c = tlv(b, p); out.push(c); p = c.start + c.hdr + c.len; }
  return out;
};
const raw = (b: Uint8Array, t: Tlv) => b.subarray(t.start, t.start + t.hdr + t.len);

interface ParsedCert {
  tbs: Uint8Array; issuerDer: Uint8Array; subjectDer: Uint8Array; cert: Certificate; key: Uint8Array;
  notBefore: number; notAfter: number; ca: boolean; pathLen: number | undefined; keyCertSign: boolean | undefined;
}

function parseCert(der: Uint8Array): ParsedCert {
  let cert: Certificate;
  try { cert = AsnConvert.parse(der, Certificate); } catch { return reject("ATT_CHAIN_INVALID"); }
  const outer = tlv(der, 0);
  if (outer.tag !== 0x30 || outer.hdr + outer.len !== der.length) reject("ATT_CHAIN_INVALID");
  const tbsT = children(der, outer)[0]!;
  const parts = children(der, tbsT);
  const off = parts[0]!.tag === 0xa0 ? 1 : 0; // optional [0] version
  const issuerT = parts[off + 2], subjectT = parts[off + 4];
  if (!issuerT || !subjectT) reject("ATT_CHAIN_INVALID");
  const tbs = cert.tbsCertificate;
  if (cert.signatureAlgorithm.algorithm !== OID_ECDSA_SHA384 || tbs.signature.algorithm !== OID_ECDSA_SHA384) reject("ATT_CHAIN_INVALID");
  if (tbs.subjectPublicKeyInfo.algorithm.algorithm !== OID_EC_PUBLIC_KEY) reject("ATT_CHAIN_INVALID");
  let ca = false, pathLen: number | undefined, keyCertSign: boolean | undefined;
  for (const ext of tbs.extensions ?? []) {
    if (ext.extnID === OID_BASIC_CONSTRAINTS) {
      const bc = AsnConvert.parse(ext.extnValue.buffer, BasicConstraints);
      ca = bc.cA; pathLen = bc.pathLenConstraint;
    } else if (ext.extnID === OID_KEY_USAGE) {
      const ku = AsnConvert.parse(ext.extnValue.buffer, KeyUsage);
      keyCertSign = (ku.toNumber() & KeyUsageFlags.keyCertSign) !== 0;
    } else if (ext.critical && !KNOWN_CRITICAL.has(ext.extnID)) reject("ATT_CHAIN_INVALID");
  }
  return {
    tbs: raw(der, tbsT), issuerDer: raw(der, issuerT!), subjectDer: raw(der, subjectT!), cert,
    key: new Uint8Array(tbs.subjectPublicKeyInfo.subjectPublicKey),
    notBefore: tbs.validity.notBefore.getTime().getTime(), notAfter: tbs.validity.notAfter.getTime().getTime(),
    ca, pathLen, keyCertSign,
  };
}

function verifyChain(chain: ParsedCert[], atMs: number): void {
  const n = chain.length;
  chain.forEach((c, i) => {
    if (atMs < c.notBefore || atMs > c.notAfter) reject("ATT_CHAIN_INVALID");
    if (i === n - 1) { if (c.ca) reject("ATT_CHAIN_INVALID"); }
    else {
      const below = n - 2 - i;
      if (!c.ca || c.keyCertSign === false || (c.pathLen !== undefined && c.pathLen < below)) reject("ATT_CHAIN_INVALID");
    }
    const parent = i === 0 ? c : chain[i - 1]!;
    if (!equal(c.issuerDer, parent.subjectDer)) reject("ATT_CHAIN_INVALID");
    try {
      // certificate signatures are DER-encoded; `prehash: true` hashes with SHA-384 (the curve default) inside noble
      if (!p384.verify(new Uint8Array(c.cert.signatureValue), c.tbs, parent.key, { format: "der", lowS: false, prehash: true })) reject("ATT_CHAIN_INVALID");
    } catch (e) { if (e instanceof Reject) throw e; reject("ATT_CHAIN_INVALID"); }
  });
}

/** V1–V5. Throws nothing; returns the AttestationVerifier result shape. */
export function verifyAwsFormatEnvelope(doc: Uint8Array, trustRoot: Uint8Array): ReturnType<AttestationVerifier["verifyEnvelope"]> {
  try {
    if (doc.length > MAX_DOC) reject("ATT_MALFORMED");
    // V1
    let top: CborValue;
    try { top = decodeCbor(doc); } catch (e) { if (e instanceof CborError || e instanceof RangeError || e instanceof TypeError) return reject("ATT_MALFORMED"); throw e; }
    if (typeof top !== "object" || top === null || Array.isArray(top) || top instanceof Uint8Array || top instanceof CborMap || (top as { tag?: number }).tag !== 18) reject("ATT_MALFORMED");
    const arr = (top as { value: CborValue }).value;
    if (!Array.isArray(arr) || arr.length !== 4) return reject("ATT_MALFORMED");
    const [protectedB, unprotected, payloadB, sigB] = arr as [CborValue, CborValue, CborValue, CborValue];
    if (!isBytes(protectedB, 64) || !isBytes(payloadB, MAX_DOC) || !isBytes(sigB, 96) || sigB.length !== 96) reject("ATT_MALFORMED");
    if (mapOf(unprotected).pairs.length !== 0) reject("ATT_MALFORMED");
    const prot = mapOf(safeDecode(protectedB as Uint8Array)); noDuplicateKeys(prot);
    if (prot.pairs.find(([k]) => k === 1)?.[1] !== -35) reject("ATT_MALFORMED");
    // V2
    const p = mapOf(safeDecode(payloadB as Uint8Array)); noDuplicateKeys(p);
    const moduleId = field(p, "module_id");
    if (typeof moduleId !== "string" || moduleId.length === 0) reject("ATT_MALFORMED");
    if (field(p, "digest") !== "SHA384") reject("ATT_MALFORMED");
    const timestamp = field(p, "timestamp");
    if (typeof timestamp !== "number" || !Number.isInteger(timestamp) || timestamp < 0) reject("ATT_MALFORMED");
    const pcrMap = mapOf(field(p, "pcrs"));
    if (pcrMap.pairs.length === 0 || pcrMap.pairs.length > 32) reject("ATT_MALFORMED");
    noDuplicateKeys(pcrMap);
    const pcrs = new Map<number, Uint8Array>();
    for (const [k, v] of pcrMap.pairs) {
      if (typeof k !== "number" || k < 0 || k >= 32 || !isBytes(v, 64) || ![32, 48, 64].includes(v.length)) reject("ATT_MALFORMED");
      pcrs.set(k as number, v as Uint8Array);
    }
    const pcr0 = pcrs.get(0);
    if (!pcr0) reject("ATT_MALFORMED");
    const certificate = field(p, "certificate");
    if (!isBytes(certificate, MAX_FIELD * 4)) reject("ATT_MALFORMED");
    const bundle = field(p, "cabundle");
    if (!Array.isArray(bundle) || bundle.length === 0 || bundle.length > 8 || !bundle.every((c) => isBytes(c, MAX_FIELD * 4))) reject("ATT_MALFORMED");
    const publicKey = optBytes(p, "public_key"), nonce = optBytes(p, "nonce");
    const userData = optBytes(p, "user_data") ?? new Uint8Array(0);
    // V3
    const ca = bundle as Uint8Array[];
    if (!equal(ca[0]!, trustRoot)) reject("ATT_ROOT_MISMATCH");
    // V4
    verifyChain([...ca, certificate as Uint8Array].map(parseCert), timestamp as number);
    // V5
    const leaf = parseCert(certificate as Uint8Array);
    let ok = false;
    try { ok = p384.verify(sigB as Uint8Array, encodeSigStructure(protectedB as Uint8Array, payloadB as Uint8Array), leaf.key, { format: "compact", lowS: false, prehash: true }); } catch { ok = false; }
    if (!ok) reject("ATT_SIGNATURE_INVALID");
    return { ok: true, measurement: pcr0!, pcrs, timestamp: timestamp as number, userData, ...(nonce ? { nonce } : {}), ...(publicKey ? { publicKey } : {}) };
  } catch (e) {
    if (e instanceof Reject) return { ok: false, code: e.code };
    throw e;
  }
}

function safeDecode(b: Uint8Array): CborValue {
  try { return decodeCbor(b); } catch (e) { if (e instanceof CborError) return reject("ATT_MALFORMED"); throw e; }
}

export const awsNitroEnclaves: AttestationVerifier = {
  platform: "aws-nitro-enclaves",
  verifyEnvelope: verifyAwsFormatEnvelope,
};
