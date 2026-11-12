// card_verifier.md §6.4 verifyServerCard — card_login.md §Acceptance Criteria (wallet validation, G2).
import { describe, it, expect } from "vitest";
import { buildWorld, type WorldOptions } from "./world.js";

const ORIGIN = "https://forum.example.org";
async function check(opts: WorldOptions = {}, origin = ORIGIN) {
  const w = buildWorld(opts);
  return w.verifier.verifyServerCard(w.b64(w.keys.server), { origin, now: w.now.toISOString() });
}

describe("verifyServerCard (card_verifier.md §6.4)", () => {
  it("valid server card, bound domain covers a subdomain origin → valid, no warnings", async () => {
    const r = await check();
    expect(r).toMatchObject({ valid: true, domain: "example.org", warnings: [] });
  });

  it("card_login §AC: request from an ordinary (T2) sub-card → LOGIN_REQUESTER_NOT_SERVER_CARD", async () => {
    expect(await check({ serverAttestation: "T2" })).toMatchObject({ valid: false, code: "LOGIN_REQUESTER_NOT_SERVER_CARD" });
  });

  it("server card without the auth_request capability → LOGIN_REQUESTER_NOT_SERVER_CARD", async () => {
    expect(await check({ serverCapabilities: ["auth_confirmation"] })).toMatchObject({ valid: false, code: "LOGIN_REQUESTER_NOT_SERVER_CARD" });
  });

  it("card_login §AC: login service card under another branch → LOGIN_SERVICE_NOT_CERTIFIED", async () => {
    expect(await check({ serviceUnderOtherBranch: true, serverAttestation: "T2" })).toMatchObject({ valid: false, code: "LOGIN_SERVICE_NOT_CERTIFIED" });
  });

  it("card_login §AC: revoked login service card (8xx) blocks → LOGIN_SERVICE_REVOKED", async () => {
    expect(await check({ serviceCodes: [800] })).toMatchObject({ valid: false, code: "LOGIN_SERVICE_REVOKED" });
  });

  it("successor set by code 101 → LOGIN_SERVICE_KEY_COMPROMISED", async () => {
    expect(await check({ serviceCodes: [101] })).toMatchObject({ valid: false, code: "LOGIN_SERVICE_KEY_COMPROMISED" });
  });

  it("card_login §AC: 6xx on the login service card warns but stays valid", async () => {
    expect(await check({ serviceCodes: [600] })).toMatchObject({ valid: true, warnings: ["LOGIN_WARN_SERVICE_NEGATIVE"] });
  });

  it("code 100 rotation warns; monitored domain warns", async () => {
    const r = await check({ serviceCodes: [100], domainReg: { fraud_risk: 1 } });
    expect(r).toMatchObject({ valid: true });
    if (r.valid) expect(r.warnings.sort()).toEqual(["LOGIN_WARN_DOMAIN_MONITORED", "LOGIN_WARN_SERVICE_ROTATED"]);
  });

  it("no domain_binding → LOGIN_DOMAIN_BINDING_MISSING", async () => {
    expect(await check({ noBinding: true })).toMatchObject({ valid: false, code: "LOGIN_DOMAIN_BINDING_MISSING" });
  });

  it("binding altered after signing → LOGIN_DOMAIN_BINDING_INVALID", async () => {
    expect(await check({ tamperBinding: true })).toMatchObject({ valid: false, code: "LOGIN_DOMAIN_BINDING_INVALID" });
  });

  it("card_login §AC: domain's admin card changed (handoff) → LOGIN_DOMAIN_BINDING_STALE", async () => {
    expect(await check({ domainReg: { admin_card_address: "ab".repeat(32) } })).toMatchObject({ valid: false, code: "LOGIN_DOMAIN_BINDING_STALE" });
  });

  it("card_login §AC: unexpired suspension → DOMAIN_SUSPENDED; lapsed suspension → valid", async () => {
    const future = Math.floor(Date.parse("2027-01-01T00:00:00Z") / 1000);
    const past = Math.floor(Date.parse("2026-01-01T00:00:00Z") / 1000);
    expect(await check({ domainReg: { fraud_risk: 2, suspension_expires_at: future } })).toMatchObject({ valid: false, code: "DOMAIN_SUSPENDED" });
    expect(await check({ domainReg: { fraud_risk: 2, suspension_expires_at: past } })).toMatchObject({ valid: true });
  });

  it("card_login §AC: wrong-origin phishing — valid card bound to example.org, origin on example.net → LOGIN_ORIGIN_NOT_BOUND", async () => {
    expect(await check({}, "https://forum.example.net")).toMatchObject({ valid: false, code: "LOGIN_ORIGIN_NOT_BOUND" });
  });

  it("card_login §AC: http and non-default port origins are not covered", async () => {
    expect(await check({}, "http://forum.example.org")).toMatchObject({ valid: false, code: "LOGIN_ORIGIN_NOT_BOUND" });
    expect(await check({}, "https://forum.example.org:8443")).toMatchObject({ valid: false, code: "LOGIN_ORIGIN_NOT_BOUND" });
  });

  it("a real revocation LogEntry at the login service card's head blocks → LOGIN_SERVICE_REVOKED (Stage 4 sees it)", async () => {
    expect(await check({ serviceHeadCode: 801 })).toMatchObject({ valid: false, code: "LOGIN_SERVICE_REVOKED" });
  });

  it("a real 6xx LogEntry at the head warns → LOGIN_WARN_SERVICE_NEGATIVE", async () => {
    expect(await check({ serviceHeadCode: 600 })).toMatchObject({ valid: true, warnings: ["LOGIN_WARN_SERVICE_NEGATIVE"] });
  });
});
