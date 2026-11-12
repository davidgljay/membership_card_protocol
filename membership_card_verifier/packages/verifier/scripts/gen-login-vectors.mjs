// Generates specs/login-conformance.json — the shared card-login conformance
// vectors (plans/card-login-code-plan.md §2.2). Expected values are computed by
// the built TS package, then checked by the TS tests, verifier-py, and the
// login router's token tests.
//
// Run with: pnpm build && node scripts/gen-login-vectors.mjs

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { ml_dsa44 } from "@noble/post-quantum/ml-dsa.js";
import { canonicalize } from "../dist/canonicalize.js";
import { keccak256 } from "../dist/crypto.js";
import { requestHash, signingBytes, domainCovers } from "../dist/login/encoding.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_PATH = join(__dirname, "../../../../specs/login-conformance.json");

const b64url = (bytes) => Buffer.from(bytes).toString("base64url");
const text = (bytes) => new TextDecoder().decode(bytes);

function keypair(seedByte) {
  const { secretKey, publicKey } = ml_dsa44.keygen(new Uint8Array(32).fill(seedByte));
  return { secretKey, publicKey, pub: b64url(publicKey), address: keccak256(publicKey) };
}
// Deterministic signatures so regenerating doesn't churn the file.
const sign = (kp, bytes) => b64url(ml_dsa44.sign(bytes, kp.secretKey, { extraEntropy: false }));

const server = keypair(0x51); // server card
const service = keypair(0x52); // login service card
const admin = keypair(0x53); // full-domain DNS admin card
const wallet = keypair(0x54); // wallet card
const policyA = "a".repeat(64);

// --- AuthenticationRequest (form_post) ---------------------------------------
const unsignedFormPost = {
  dcql_query: {
    credentials: [
      { id: "membership", format: "mcard", meta: { policies: [{ id: policyA, include_children: true }] } },
    ],
  },
  expires_at: "2026-11-09T12:10:00Z",
  nonce: b64url(new Uint8Array(32).fill(7)),
  purpose: "Log in to the member forum",
  requester_card: server.address,
  requester_pubkey: server.pub,
  response_mode: "form_post",
  response_uri: "https://forum.example.org/login/callback",
  state: b64url(new Uint8Array(16).fill(9)),
  statement: "Log in to https://forum.example.org",
  version: "2",
};
const formPost = { ...unsignedFormPost, request_signature: sign(server, canonicalize(unsignedFormPost)) };

// --- AuthenticationRequest (mcard_message, wallet-initiated, with context) ----
const unsignedMessage = {
  ...unsignedFormPost,
  context: { reason: "Weekly meetup RSVP" },
  response_mode: "mcard_message",
  wallet_nonce: b64url(new Uint8Array(16).fill(3)),
};
const message = { ...unsignedMessage, request_signature: sign(server, canonicalize(unsignedMessage)) };

// --- DomainBindingAttestation -------------------------------------------------
const unsignedBinding = {
  admin_card: admin.address,
  admin_card_pubkey: admin.pub,
  domain: "example.org",
  issued_at: "2026-11-01T00:00:00Z",
  login_service_card: service.address,
  login_service_card_pubkey: service.pub,
};
const binding = { ...unsignedBinding, admin_signature: sign(admin, canonicalize(unsignedBinding)) };

// --- LoginServiceMetadata ------------------------------------------------------
const metadataBody = {
  accepts: [{ id: policyA, include_children: true }],
  name: "Member Forum",
  origin: "https://forum.example.org",
  response_modes: ["form_post", "mcard_message"],
  server_card: server.address,
  server_card_pubkey: server.pub,
  start_url: "https://forum.example.org/login/start",
  updated_at: "2026-11-01T00:00:00Z",
  version: "1",
};
const metadata = { metadata: metadataBody, signature: sign(server, canonicalize(metadataBody)) };

// --- WalletRegistrationToken ---------------------------------------------------
const tokenBody = {
  app_card: wallet.address,
  app_card_pubkey: wallet.pub,
  expires_at: "2027-11-01T00:00:00Z",
  handler_url: "https://wallet.example.net/login",
  issued_at: "2026-11-01T00:00:00Z",
  name: "Example Wallet",
  router_origin: "https://router.example.com",
  version: "1",
};
const token = { token: tokenBody, signature: sign(wallet, canonicalize(tokenBody)) };

function signatureCase(id, kind, pubkey, object, signatureField, valid, description) {
  return { id, kind, description, public_key: pubkey, object, signature_field: signatureField, expected_valid: valid };
}
const tampered = (o, path, value) => {
  const copy = structuredClone(o);
  let t = copy;
  for (const k of path.slice(0, -1)) t = t[k];
  t[path[path.length - 1]] = value;
  return copy;
};

const vectors = {
  version: "1.0",
  description:
    "Card login conformance vectors (process_specs/card_login.md). Addresses are keccak256(pubkey) hex. Regenerate with membership_card_verifier/packages/verifier/scripts/gen-login-vectors.mjs.",
  request_hash: [formPost, message].map((req, i) => ({
    id: `RH-0${i + 1}`,
    description: i === 0 ? "form_post request" : "mcard_message request with context and wallet_nonce",
    input: req,
    expected_canonical: text(canonicalize(req)),
    expected_request_hash: requestHash(req),
  })),
  signatures: [
    signatureCase("SIG-01", "AuthenticationRequest", server.pub, formPost, "request_signature", true, "valid request signature"),
    signatureCase("SIG-02", "AuthenticationRequest", server.pub, tampered(formPost, ["response_uri"], "https://evil.example.net/cb"), "request_signature", false, "response_uri changed after signing"),
    signatureCase("SIG-03", "DomainBindingAttestation", admin.pub, binding, "admin_signature", true, "valid binding"),
    signatureCase("SIG-04", "DomainBindingAttestation", admin.pub, tampered(binding, ["domain"], "example.net"), "admin_signature", false, "domain changed after signing"),
    signatureCase("SIG-05", "LoginServiceMetadata", server.pub, metadata, null, true, "valid metadata (signature over `metadata`)"),
    signatureCase("SIG-06", "LoginServiceMetadata", server.pub, tampered(metadata, ["metadata", "start_url"], "https://evil.example.net/"), null, false, "start_url changed after signing"),
    signatureCase("SIG-07", "WalletRegistrationToken", wallet.pub, token, null, true, "valid token (signature over `token`)"),
    signatureCase("SIG-08", "WalletRegistrationToken", wallet.pub, tampered(token, ["token", "router_origin"], "https://other-router.example.com"), null, false, "router_origin changed after signing"),
  ],
  domain_coverage: [
    ["example.org", "https://example.org", true],
    ["example.org", "https://login.example.org", true],
    ["example.org", "https://a.b.example.org", true],
    ["example.org", "https://EXAMPLE.org", true],
    ["example.org", "http://example.org", false],
    ["example.org", "https://example.org:8443", false],
    ["example.org", "https://example.net", false],
    ["example.org", "https://notexample.org", false],
    ["example.org", "https://example.org.evil.net", false],
    ["example.org", "https://192.0.2.1", false],
  ].map(([domain, origin, covered], i) => {
    if (domainCovers(domain, origin) !== covered) throw new Error(`coverage vector ${i} disagrees with implementation`);
    return { id: `DC-${String(i + 1).padStart(2, "0")}`, domain, origin, expected_covered: covered };
  }),
  // Abstract policy tree for §8.1 matching and §2 inheritance. `parent` is the
  // policy reached by the issuance-chain walk (issuer card → its policy).
  policy_tree: {
    root: { parent: null, preferred_services: [{ origin: "https://forum.example.org", name: "Member Forum" }] },
    chapter: { parent: "root" },
    team: { parent: "chapter", preferred_services: [] },
    project: { parent: "team" },
    other: { parent: null },
  },
  dcql_match: [
    { id: "DM-01", card_policy: "root", query: [["root", false]], expected_match: "root" },
    { id: "DM-02", card_policy: "chapter", query: [["root", false]], expected_match: null },
    { id: "DM-03", card_policy: "chapter", query: [["root", true]], expected_match: "root" },
    { id: "DM-04", card_policy: "project", query: [["root", true]], expected_match: "root" },
    { id: "DM-05", card_policy: "other", query: [["root", true]], expected_match: null },
    { id: "DM-06", card_policy: "team", query: [["other", true], ["chapter", true]], expected_match: "chapter" },
  ].map((c) => ({ ...c, query: c.query.map(([id, include_children]) => ({ id, include_children })) })),
  preferred_services: [
    { id: "PS-01", card_policy: "root", expected: [{ origin: "https://forum.example.org", name: "Member Forum" }], description: "own list" },
    { id: "PS-02", card_policy: "chapter", expected: [{ origin: "https://forum.example.org", name: "Member Forum" }], description: "absent → inherit" },
    { id: "PS-03", card_policy: "team", expected: [], description: "[] → none, no inheritance" },
    { id: "PS-04", card_policy: "project", expected: [], description: "inherits the nearest ancestor's [] " },
    { id: "PS-05", card_policy: "other", expected: [], description: "no policy on the chain sets it" },
  ],
};

writeFileSync(OUT_PATH, JSON.stringify(vectors, null, 2) + "\n");
console.log(`wrote ${OUT_PATH}`);
