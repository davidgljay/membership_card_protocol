// card_verifier.md §6.3 verifyLoginResponse — card_login.md §Acceptance Criteria (G3).
import { describe, it, expect } from "vitest";
import { generateKeypair } from "../fixtures.js";
import { buildWorld } from "./world.js";

const ORIGIN = "https://forum.example.org";

function setup(opts: Parameters<typeof buildWorld>[0] = {}) {
  const w = buildWorld(opts);
  const request = w.makeRequest();
  const verify = (response: ReturnType<typeof w.makeResponse>, req = request) =>
    w.verifier.verifyLoginResponse({ response, request: req, expectedOrigin: ORIGIN, now: w.now.toISOString() });
  return { w, request, verify };
}

describe("verifyLoginResponse (card_verifier.md §6.3)", () => {
  it("valid form_post response from a child-policy card with include_children → valid", async () => {
    const { w, request, verify } = setup();
    const r = await verify(w.makeResponse(request));
    expect(r).toMatchObject({ valid: true, presented_card: w.keys.user.address, login_service_card: w.keys.service.address });
  });

  it("accepts the bare envelope (mcard_message)", async () => {
    const { w, request } = setup();
    const r = await w.verifier.verifyLoginResponse({ response: w.makeResponse(request).signed_statement, request, expectedOrigin: ORIGIN, now: w.now.toISOString() });
    expect(r.valid).toBe(true);
  });

  const tamper: [string, Record<string, unknown>, string][] = [
    ["state", { state: "x" }, "LOGIN_STATE_MISMATCH"],
    ["nonce", { nonce: "x" }, "LOGIN_NONCE_MISMATCH"],
    ["statement", { statement: "x" }, "LOGIN_STATEMENT_MISMATCH"],
    ["request_hash", { request_hash: "x" }, "LOGIN_REQUEST_HASH_MISMATCH"],
    ["audience", { audience: "https://evil.example.net" }, "LOGIN_AUDIENCE_MISMATCH"],
  ];
  for (const [field, content, code] of tamper) {
    it(`card_login §AC: tampered ${field} → ${code}`, async () => {
      const { w, request, verify } = setup();
      expect(await verify(w.makeResponse(request, { content }))).toMatchObject({ valid: false, code });
    });
  }

  it("card_login §AC: recipients not the login service card → LOGIN_RECIPIENT_MISMATCH", async () => {
    const { w, request, verify } = setup();
    expect(await verify(w.makeResponse(request, { payload: { recipients: [w.keys.server.address] } }))).toMatchObject({ valid: false, code: "LOGIN_RECIPIENT_MISMATCH" });
  });

  it("wrong type → LOGIN_WRONG_TYPE", async () => {
    const { w, request, verify } = setup();
    expect(await verify(w.makeResponse(request, { payload: { type: "text" } }))).toMatchObject({ valid: false, code: "LOGIN_WRONG_TYPE" });
  });

  it("card_login §AC: response older than 5 minutes → LOGIN_RESPONSE_STALE", async () => {
    const { w, request } = setup();
    const r = await w.verifier.verifyLoginResponse({ response: w.makeResponse(request), request, expectedOrigin: ORIGIN, now: "2026-11-09T12:20:00Z" });
    expect(r).toMatchObject({ valid: false, code: "LOGIN_RESPONSE_STALE" });
  });

  it("senders names a different card than the signer → LOGIN_SENDER_MISMATCH", async () => {
    const { w, request, verify } = setup();
    expect(await verify(w.makeResponse(request, { payload: { senders: [w.keys.issuer.address] } }))).toMatchObject({ valid: false, code: "LOGIN_SENDER_MISMATCH" });
  });

  it("signed by an unregistered key → LOGIN_PRESENTED_CARD_INVALID", async () => {
    const { w, request, verify } = setup();
    const stranger = generateKeypair();
    expect(await verify(w.makeResponse(request, { signer: stranger, payload: { senders: [stranger.address] } }))).toMatchObject({ valid: false, code: "LOGIN_PRESENTED_CARD_INVALID" });
  });

  it("card_login §AC: child-policy card when include_children is false → LOGIN_CARD_NOT_ACCEPTED", async () => {
    const w = buildWorld();
    const request = w.makeRequest({
      dcql_query: { credentials: [{ id: "m", format: "mcard", meta: { policies: [{ id: w.keys.policyRoot.address, include_children: false }] } }] },
    });
    const r = await w.verifier.verifyLoginResponse({ response: w.makeResponse(request), request, expectedOrigin: ORIGIN, now: w.now.toISOString() });
    expect(r).toMatchObject({ valid: false, code: "LOGIN_CARD_NOT_ACCEPTED" });
  });

  it("card under an unrelated policy → LOGIN_CARD_NOT_ACCEPTED", async () => {
    const { w, request, verify } = setup({ userPolicy: "unrelated" });
    expect(await verify(w.makeResponse(request))).toMatchObject({ valid: false, code: "LOGIN_CARD_NOT_ACCEPTED" });
  });

  it("card directly under the requested policy with include_children false → valid", async () => {
    const w = buildWorld({ userPolicy: "root" });
    const request = w.makeRequest({
      dcql_query: { credentials: [{ id: "m", format: "mcard", meta: { policies: [{ id: w.keys.policyRoot.address, include_children: false }] } }] },
    });
    const r = await w.verifier.verifyLoginResponse({ response: w.makeResponse(request), request, expectedOrigin: ORIGIN, now: w.now.toISOString() });
    expect(r.valid).toBe(true);
  });
});
