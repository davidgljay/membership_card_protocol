/**
 * Pure helpers shared by every login component: the request hash, origin
 * normalization, and the domain-binding coverage rule. No network access.
 */

import { keccak_256 } from "@noble/hashes/sha3";
import { canonicalize } from "../canonicalize.js";
import { bytesToBase64Url } from "../crypto.js";
import type { AuthenticationRequest } from "./types.js";

/**
 * protocol-objects.md §8 — base64url(keccak256(canonical RFC 8785 JSON of the
 * complete AuthenticationRequest, including request_signature)).
 */
export function requestHash(request: AuthenticationRequest): string {
  return bytesToBase64Url(keccak_256(canonicalize(request)));
}

/**
 * Canonical bytes a signer signs: the object without its signature field.
 * Used for request_signature (§8), admin_signature (§17), and the wrapped
 * `metadata` / `token` bodies (§18, §19 — pass the body itself).
 */
export function signingBytes<T extends object>(obj: T, signatureField?: keyof T): Uint8Array {
  if (signatureField === undefined) return canonicalize(obj);
  const copy: Record<string, unknown> = { ...(obj as Record<string, unknown>) };
  delete copy[signatureField as string];
  return canonicalize(copy);
}

/**
 * Returns the origin of an absolute https URL that satisfies the
 * response_uri rules (protocol-objects.md §8): https scheme, no userinfo, no
 * fragment. Returns null for anything else. Default port is omitted from the
 * result, so "https://a.com:443/x" → "https://a.com".
 */
export function httpsOrigin(url: string, opts: { allowFragment?: boolean } = {}): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== "https:") return null;
  if (u.username || u.password) return null;
  if (!opts.allowFragment && u.hash) return null;
  return u.origin;
}

/**
 * protocol-objects.md §17 coverage rule: an origin is covered by a binding to
 * `domain` when its scheme is https, its port is the default (443), and its
 * host equals `domain` or ends with "." + domain. IP literals are never covered.
 */
export function domainCovers(domain: string, origin: string): boolean {
  const d = domain.toLowerCase().replace(/\.$/, "");
  if (!d || d.includes("/") || d.includes(":")) return false;
  let u: URL;
  try {
    u = new URL(origin);
  } catch {
    return false;
  }
  if (u.protocol !== "https:" || u.port !== "") return false;
  const host = u.hostname.toLowerCase();
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || host.startsWith("[")) return false;
  return host === d || host.endsWith("." + d);
}
