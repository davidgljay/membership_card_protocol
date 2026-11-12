/**
 * DomainBindingAttestation checks — protocol-objects.md §17: binding checks,
 * signature, currency rule (against DomainRegistrations), coverage rule.
 */

import { keccak256, base64UrlToBytes, mlDsa44Verify } from "../crypto.js";
import { CardProtocolError } from "../errors.js";
import type { RpcProvider } from "../types.js";
import { signingBytes, domainCovers } from "./encoding.js";
import { normAddress } from "./chain.js";
import type { DomainBindingAttestation } from "./types.js";

export type DomainBindingResult =
  | { ok: true; domain: string; monitored: boolean }
  | {
      ok: false;
      code:
        | "LOGIN_DOMAIN_BINDING_MISSING"
        | "LOGIN_DOMAIN_BINDING_INVALID"
        | "LOGIN_DOMAIN_BINDING_STALE"
        | "DOMAIN_SUSPENDED"
        | "LOGIN_ORIGIN_NOT_BOUND";
      reason: string;
    };

/** Signature and binding checks only — no chain reads. Used by the press too. */
export function checkDomainBindingSignature(
  binding: unknown,
  loginServiceCardAddress: string
): { ok: true; binding: DomainBindingAttestation } | { ok: false; reason: string } {
  const b = binding as Partial<DomainBindingAttestation> | undefined;
  if (!b || typeof b !== "object") return { ok: false, reason: "domain_binding is not an object" };
  for (const f of ["admin_card", "admin_card_pubkey", "admin_signature", "domain", "issued_at", "login_service_card", "login_service_card_pubkey"] as const) {
    if (typeof b[f] !== "string" || !b[f]) return { ok: false, reason: `domain_binding.${f} missing` };
  }
  const att = b as DomainBindingAttestation;
  if (att.domain !== att.domain.toLowerCase() || att.domain.endsWith(".")) {
    return { ok: false, reason: "domain must be lowercase with no trailing dot" };
  }
  try {
    const servicePk = new Uint8Array(base64UrlToBytes(att.login_service_card_pubkey));
    const adminPk = new Uint8Array(base64UrlToBytes(att.admin_card_pubkey));
    if (keccak256(servicePk) !== normAddress(att.login_service_card)) return { ok: false, reason: "login_service_card_pubkey does not bind to login_service_card" };
    if (normAddress(att.login_service_card) !== normAddress(loginServiceCardAddress)) return { ok: false, reason: "binding names a different login service card" };
    if (keccak256(adminPk) !== normAddress(att.admin_card)) return { ok: false, reason: "admin_card_pubkey does not bind to admin_card" };
    const ok = mlDsa44Verify(adminPk, signingBytes(att, "admin_signature"), new Uint8Array(base64UrlToBytes(att.admin_signature)));
    if (!ok) return { ok: false, reason: "admin_signature does not verify" };
  } catch (e) {
    return { ok: false, reason: `malformed key or signature: ${String(e)}` };
  }
  return { ok: true, binding: att };
}

/**
 * Full §17 check of a login service card's binding for `origin`.
 * `isCardCurrentlyValid` lets the caller reuse the verifier's revocation check
 * for the admin card.
 */
export async function checkDomainBinding(options: {
  binding: unknown;
  loginServiceCardAddress: string;
  origin: string;
  rpc: RpcProvider;
  isCardCurrentlyValid: (address: string) => Promise<boolean>;
  now?: Date;
}): Promise<DomainBindingResult> {
  if (options.binding === undefined || options.binding === null) {
    return { ok: false, code: "LOGIN_DOMAIN_BINDING_MISSING", reason: "login service card has no domain_binding" };
  }
  const sig = checkDomainBindingSignature(options.binding, options.loginServiceCardAddress);
  if (!sig.ok) return { ok: false, code: "LOGIN_DOMAIN_BINDING_INVALID", reason: sig.reason };
  const att = sig.binding;

  if (!options.rpc.getDomainRegistration) {
    throw new CardProtocolError("MISSING_RPC_METHOD", "RpcProvider.getDomainRegistration is required for card login");
  }
  const reg = await options.rpc.getDomainRegistration(att.domain);
  if (!reg || normAddress(reg.admin_card_address) !== normAddress(att.admin_card)) {
    return { ok: false, code: "LOGIN_DOMAIN_BINDING_STALE", reason: `${att.admin_card} is no longer the admin card for ${att.domain}` };
  }
  if (!(await options.isCardCurrentlyValid(normAddress(att.admin_card)))) {
    return { ok: false, code: "LOGIN_DOMAIN_BINDING_STALE", reason: "the signing admin card is revoked" };
  }
  const nowSec = Math.floor((options.now ?? new Date()).getTime() / 1000);
  if (reg.fraud_risk === 2 && nowSec < reg.suspension_expires_at) {
    return { ok: false, code: "DOMAIN_SUSPENDED", reason: `${att.domain} is suspended` };
  }
  if (!domainCovers(att.domain, options.origin)) {
    return { ok: false, code: "LOGIN_ORIGIN_NOT_BOUND", reason: `${options.origin} is not covered by a binding to ${att.domain}` };
  }
  return { ok: true, domain: att.domain, monitored: reg.fraud_risk === 1 };
}
