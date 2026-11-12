// card_verifier.md §7.2 step 16f — login service branch and scope rule.
import { describe, it, expect, vi } from "vitest";
import { verifyStage2 } from "../../src/stages/stage2.js";
import { generateKeypair, encryptForCard, makeCardDoc, makeSubCardDoc } from "../fixtures.js";
import type { RpcProvider, IpfsProvider, SubCardEntry, SubCardDocument } from "../../src/types.js";

type Kp = ReturnType<typeof generateKeypair>;
const b64 = (k: Kp) => Buffer.from(k.publicKey).toString("base64url");
const enc = (k: Kp, doc: unknown) => encryptForCard(k.publicKey, new TextEncoder().encode(JSON.stringify(doc)));

/**
 * Builds: root ← branch node ← app card (the certifying card), a master card,
 * and a sub-card of the master certified by the app card. When `selfScoped`,
 * the app card IS the master (a server card).
 */
function scenario(opts: { selfScoped: boolean; attestation?: SubCardDocument["attestation_level"] }) {
  const root = generateKeypair();
  const branch = generateKeypair();
  const app = generateKeypair();
  const holder = opts.selfScoped ? app : generateKeypair();
  const sub = generateKeypair();
  const press = generateKeypair();

  const subDoc = makeSubCardDoc(holder.publicKey, holder.secretKey, app.publicKey, app.secretKey, sub.publicKey, {
    attestation_level: opts.attestation ?? "T2",
  });
  const appDoc = makeCardDoc(app.publicKey, branch.secretKey, app.secretKey, press.secretKey, [b64(branch)]);
  const branchDoc = makeCardDoc(branch.publicKey, root.secretKey, branch.secretKey, press.secretKey, [b64(root)]);
  const masterDoc = opts.selfScoped ? appDoc : makeCardDoc(holder.publicKey, root.secretKey, holder.secretKey, press.secretKey);
  masterDoc.active_subcards = [b64(sub)];

  const docs: Record<string, [Kp, unknown]> = {
    [sub.address]: [sub, subDoc],
    [holder.address]: [holder, masterDoc],
    [app.address]: [app, appDoc],
    [branch.address]: [branch, branchDoc],
  };
  const rpc: RpcProvider = {
    getCardEntry: vi.fn().mockImplementation((addr: string) =>
      Promise.resolve(docs[addr] ? { exists: true, log_head_cid: `Qm${addr}`, policy_address: "0x", last_press_address: "0x", forward_to: null } : null)
    ),
    isPolicyAuthorizer: vi.fn().mockResolvedValue(false),
    getPressAuthorization: vi.fn().mockResolvedValue(null),
    getSubCardEntry: vi.fn().mockResolvedValue({ master_card_address: holder.address, registration_log_head: "0x", sub_card_doc_cid: "QmSub", active: true, registered_at: "2026-01-01T00:00:00Z", deregistered_at: null } as SubCardEntry),
    getCardEventLog: vi.fn().mockResolvedValue([]),
    getEasAnnotations: vi.fn().mockResolvedValue([]),
  };
  const ipfs: IpfsProvider = {
    fetch: vi.fn().mockImplementation((cid: string) => {
      const addr = cid.slice(2);
      const entry = docs[addr];
      return entry ? Promise.resolve(enc(entry[0], entry[1])) : Promise.reject(new Error(`CID not found: ${cid}`));
    }),
  };
  return { root, branch, sub, rpc, ipfs };
}

describe("stage2 §7.2 step 16f — login service branch", () => {
  it("server card (login service card is app_card and holder, S1) → scope_clean, branch login_service", async () => {
    const s = scenario({ selfScoped: true, attestation: "S1" });
    const r = await verifyStage2(s.sub.publicKey, s.rpc, s.ipfs, { appCertificationRoot: s.root.address, loginServiceCertificationRoot: s.branch.address });
    expect(r.errors).toEqual([]);
    expect(r.scope_clean).toBe(true);
    expect(r.app_card_branch).toBe("login_service");
    expect(r.sub_card_doc?.attestation_level).toBe("S1");
  });

  it("login service card as app_card for another master → LOGIN_SERVICE_SCOPE (login service card posing as an app)", async () => {
    const s = scenario({ selfScoped: false });
    const r = await verifyStage2(s.sub.publicKey, s.rpc, s.ipfs, { appCertificationRoot: s.root.address, loginServiceCertificationRoot: s.branch.address });
    expect(r.scope_clean).toBe(false);
    expect(r.errors.map((e) => e.code)).toContain("LOGIN_SERVICE_SCOPE");
  });

  it("app or wallet branch (branch node is not the login service root) → branch other, scope_clean", async () => {
    const s = scenario({ selfScoped: false });
    const r = await verifyStage2(s.sub.publicKey, s.rpc, s.ipfs, { appCertificationRoot: s.root.address, loginServiceCertificationRoot: "5e".repeat(32) });
    expect(r.scope_clean).toBe(true);
    expect(r.app_card_branch).toBe("other");
  });

  it("S1 on an ordinary app-certified sub-card → ATTESTATION_LEVEL_INSUFFICIENT", async () => {
    const s = scenario({ selfScoped: false, attestation: "S1" });
    const r = await verifyStage2(s.sub.publicKey, s.rpc, s.ipfs, { appCertificationRoot: s.root.address, loginServiceCertificationRoot: "5e".repeat(32) });
    expect(r.scope_clean).toBe(false);
    expect(r.errors.map((e) => e.code)).toContain("ATTESTATION_LEVEL_INSUFFICIENT");
  });

  it("sub-card verified without loginServiceCertificationRoot → LOGIN_SERVICE_CERTIFICATION_ROOT_NOT_CONFIGURED", async () => {
    const s = scenario({ selfScoped: false });
    const r = await verifyStage2(s.sub.publicKey, s.rpc, s.ipfs, { appCertificationRoot: s.root.address });
    expect(r.scope_clean).toBe(false);
    expect(r.errors.map((e) => e.code)).toContain("LOGIN_SERVICE_CERTIFICATION_ROOT_NOT_CONFIGURED");
  });
});
