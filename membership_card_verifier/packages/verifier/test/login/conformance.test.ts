import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalize } from "../../src/canonicalize.js";
import { base64UrlToBytes, mlDsa44Verify } from "../../src/crypto.js";
import { requestHash, signingBytes, domainCovers, httpsOrigin } from "../../src/login/encoding.js";
import type { AuthenticationRequest } from "../../src/login/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const loginVectors = JSON.parse(
  readFileSync(join(__dirname, "../../../../../specs/login-conformance.json"), "utf-8")
);

describe("login-conformance.json — protocol-objects.md §8 request hash", () => {
  for (const c of loginVectors.request_hash) {
    it(`${c.id}: ${c.description}`, () => {
      expect(new TextDecoder().decode(canonicalize(c.input))).toBe(c.expected_canonical);
      expect(requestHash(c.input as AuthenticationRequest)).toBe(c.expected_request_hash);
    });
  }
});

describe("login-conformance.json — signatures (§8, §17, §18, §19)", () => {
  for (const c of loginVectors.signatures) {
    it(`${c.id}: ${c.kind} — ${c.description}`, () => {
      let bytes: Uint8Array;
      let sig: string;
      if (c.signature_field) {
        bytes = signingBytes(c.object, c.signature_field);
        sig = c.object[c.signature_field];
      } else {
        const body = c.kind === "LoginServiceMetadata" ? c.object.metadata : c.object.token;
        bytes = signingBytes(body);
        sig = c.object.signature;
      }
      expect(mlDsa44Verify(base64UrlToBytes(c.public_key), bytes, base64UrlToBytes(sig))).toBe(c.expected_valid);
    });
  }
});

describe("login-conformance.json — §17 domain coverage rule", () => {
  for (const c of loginVectors.domain_coverage) {
    it(`${c.id}: ${c.domain} covers ${c.origin} → ${c.expected_covered}`, () => {
      expect(domainCovers(c.domain, c.origin)).toBe(c.expected_covered);
    });
  }
});

describe("httpsOrigin — §8 response_uri rules", () => {
  it("strips default port and path", () => {
    expect(httpsOrigin("https://a.example:443/x?y")).toBe("https://a.example");
  });
  it("keeps a non-default port", () => {
    expect(httpsOrigin("https://a.example:8443/x")).toBe("https://a.example:8443");
  });
  it("rejects http, userinfo, fragments, and garbage", () => {
    expect(httpsOrigin("http://a.example/x")).toBeNull();
    expect(httpsOrigin("https://u:p@a.example/x")).toBeNull();
    expect(httpsOrigin("https://a.example/x#f")).toBeNull();
    expect(httpsOrigin("not a url")).toBeNull();
  });
});
