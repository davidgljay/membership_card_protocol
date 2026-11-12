/**
 * A complete card-login world for verifier tests (process_specs/card_login.md):
 *
 *   appRoot (app-certification root, trusted)
 *    └── loginBranch (VerifierConfig.loginServiceCertificationRoot)
 *         └── service (login service card; head is a LogEntry carrying
 *              active_subcards + domain_binding)
 *              └── server (server card sub-card: app_card = holder = service, S1)
 *   admin (full-domain DNS admin card for example.org)
 *
 *   userRoot (trusted)
 *    └── issuer (card under policy "root")
 *         policy "child" is issued by `issuer`, so its parent is "root"
 *    └── user card (issued under policy "child")
 *
 * All crypto is real; RPC and IPFS are in-memory.
 */
import { vi } from "vitest";
import { ml_dsa44 } from "@noble/post-quantum/ml-dsa.js";
import { canonicalize } from "../../src/canonicalize.js";
import { CardVerifier } from "../../src/CardVerifier.js";
import { requestHash } from "../../src/login/encoding.js";
import { generateKeypair, encryptForCard, makeCardDoc, makeSubCardDoc, sign } from "../fixtures.js";
import type { RpcProvider, IpfsProvider, SubCardDocument, LogUpdate, CardChainEvent } from "../../src/types.js";
import type { AuthenticationRequest, AuthenticationResponse, DomainBindingAttestation } from "../../src/login/types.js";

type Kp = ReturnType<typeof generateKeypair>;
const b64 = (k: Kp | Uint8Array) => Buffer.from(k instanceof Uint8Array ? k : k.publicKey).toString("base64url");
const json = (o: unknown) => new TextEncoder().encode(JSON.stringify(o));

export interface WorldOptions {
  /** Server card attestation level (default S1). */
  serverAttestation?: SubCardDocument["attestation_level"];
  /** Server card capabilities (default auth_request, auth_confirmation, error). */
  serverCapabilities?: string[];
  /** Put the service card under a different (non-login) branch. */
  serviceUnderOtherBranch?: boolean;
  /** Domain named in the binding (default example.org). */
  bindingDomain?: string;
  /** Omit domain_binding from the service card. */
  noBinding?: boolean;
  /** Tamper with the binding after signing. */
  tamperBinding?: boolean;
  /** DomainRegistrations result overrides. */
  domainReg?: { admin_card_address?: string; fraud_risk?: 0 | 1 | 2; suspension_expires_at?: number } | null;
  /** Update codes on the service card's own log (e.g. 600, 100, 101, 800). */
  serviceCodes?: number[];
  /**
   * Make the login service card's real head a LogEntry with this code — 8xx/9xx
   * as a revocation, otherwise a field update — so Stage 4 sees it the way it
   * would on chain (no injected codes).
   */
  serviceHeadCode?: number;
  /** The user's card policy (default "child"). */
  userPolicy?: "root" | "child" | "unrelated";
}

export function buildWorld(opts: WorldOptions = {}) {
  const appRoot = generateKeypair();
  const loginBranch = generateKeypair();
  const otherBranch = generateKeypair();
  const service = generateKeypair();
  const server = generateKeypair();
  const admin = generateKeypair();
  const userRoot = generateKeypair();
  const issuer = generateKeypair();
  const user = generateKeypair();
  const device = generateKeypair(); // the user's device sub-card
  const walletCard = generateKeypair(); // certifies the device sub-card (under the other branch)
  const press = generateKeypair();
  const policyRootKp = generateKeypair();
  const policyChildKp = generateKeypair();
  const policyOtherKp = generateKeypair();

  const blobs: Record<string, Uint8Array> = {};
  const entries: Record<string, string> = {}; // address → head CID
  const put = (cid: string, bytes: Uint8Array) => (blobs[cid] = bytes);
  const register = (kp: Kp, doc: unknown, cid: string) => {
    put(cid, encryptForCard(kp.publicKey, json(doc)));
    entries[kp.address] = cid;
  };

  // Policies: plaintext snapshots at their policy_id CIDs, and registered heads.
  const policyDoc = (kp: Kp, ancestry: string[], extra: Record<string, unknown> = {}) => ({
    recipient_pubkey: b64(kp),
    ancestry_pubkeys: ancestry,
    field_definitions: {},
    ...extra,
  });
  const policies = {
    root: { kp: policyRootKp, cid: "QmPolicyRoot", doc: policyDoc(policyRootKp, [b64(userRoot)]) },
    child: { kp: policyChildKp, cid: "QmPolicyChild", doc: policyDoc(policyChildKp, [b64(issuer)]) },
    unrelated: { kp: policyOtherKp, cid: "QmPolicyOther", doc: policyDoc(policyOtherKp, [b64(userRoot)]) },
  };
  for (const p of Object.values(policies)) {
    put(p.cid, json(p.doc));
    register(p.kp, p.doc, `${p.cid}-head`);
  }
  put("QmPolicyPlain", json({ field_definitions: {} }));

  // User side.
  register(issuer, makeCardDoc(issuer.publicKey, userRoot.secretKey, issuer.secretKey, press.secretKey, [b64(userRoot)], { policy_id: policies.root.cid }), "QmIssuer");
  const userPolicy = policies[opts.userPolicy ?? "child"];
  register(user, makeCardDoc(user.publicKey, issuer.secretKey, user.secretKey, press.secretKey, [b64(issuer)], { policy_id: userPolicy.cid, active_subcards: [b64(device)] }), "QmUser");

  // Login service side.
  const branch = opts.serviceUnderOtherBranch ? otherBranch : loginBranch;
  register(loginBranch, makeCardDoc(loginBranch.publicKey, appRoot.secretKey, loginBranch.secretKey, press.secretKey, [b64(appRoot)], { policy_id: "QmPolicyPlain" }), "QmLoginBranch");
  register(otherBranch, makeCardDoc(otherBranch.publicKey, appRoot.secretKey, otherBranch.secretKey, press.secretKey, [b64(appRoot)], { policy_id: "QmPolicyPlain" }), "QmOtherBranch");
  register(walletCard, makeCardDoc(walletCard.publicKey, otherBranch.secretKey, walletCard.secretKey, press.secretKey, [b64(otherBranch)], { policy_id: "QmPolicyPlain" }), "QmWalletCard");
  register(device, makeSubCardDoc(user.publicKey, user.secretKey, walletCard.publicKey, walletCard.secretKey, device.publicKey, { capabilities: ["auth_response"] }), "QmDevice");
  register(admin, makeCardDoc(admin.publicKey, userRoot.secretKey, admin.secretKey, press.secretKey, [b64(userRoot)], { policy_id: "QmPolicyPlain" }), "QmAdmin");

  const unsignedBinding = {
    admin_card: admin.address,
    admin_card_pubkey: b64(admin),
    domain: opts.bindingDomain ?? "example.org",
    issued_at: "2026-11-01T00:00:00Z",
    login_service_card: service.address,
    login_service_card_pubkey: b64(service),
  };
  let binding: DomainBindingAttestation = { ...unsignedBinding, admin_signature: sign(admin.secretKey, unsignedBinding) };
  if (opts.tamperBinding) binding = { ...binding, issued_at: "2026-11-02T00:00:00Z" };

  const serviceGenesis = makeCardDoc(service.publicKey, branch.secretKey, service.secretKey, press.secretKey, [b64(branch)], { policy_id: "QmPolicyPlain" });
  put("QmServiceGenesis", encryptForCard(service.publicKey, json(serviceGenesis)));
  const headCode = opts.serviceHeadCode ?? 520;
  const serviceHead = {
    version: 2,
    code: headCode,
    entry_type: headCode >= 800 ? "revocation" : "field_update",
    ...(headCode >= 800 ? { revocation: { effective_date: "2026-11-01T00:00:00Z" } } : {}),
    history: ["QmServiceGenesis"],
    card_state: {
      active_subcards: [b64(server)],
      ...(opts.noBinding ? {} : { domain_binding: binding }),
    },
  };
  put("QmServiceHead", encryptForCard(service.publicKey, json(serviceHead)));
  entries[service.address] = "QmServiceHead";

  const serverDoc = makeSubCardDoc(service.publicKey, service.secretKey, service.publicKey, service.secretKey, server.publicKey, {
    attestation_level: opts.serverAttestation ?? "S1",
    capabilities: opts.serverCapabilities ?? ["auth_request", "auth_confirmation", "error"],
  });
  register(server, serverDoc, "QmServer");

  // Events: one revocation or annotation per requested service code.
  const serviceUpdates: LogUpdate[] = (opts.serviceCodes ?? []).map((code, i) => ({
    card_address: service.address,
    update_code: code,
    cid: `QmServiceUpdate${i}`,
    effective_date: "2026-11-01T00:00:00Z",
  }));

  const rpc: RpcProvider = {
    getCardEntry: vi.fn().mockImplementation((addr: string) =>
      Promise.resolve(entries[addr] ? { exists: true, log_head_cid: entries[addr], policy_address: "0x", last_press_address: press.address, forward_to: null } : null)
    ),
    isPolicyAuthorizer: vi.fn().mockImplementation((addr: string) => Promise.resolve(addr === appRoot.address || addr === userRoot.address)),
    getPressAuthorization: vi.fn().mockResolvedValue({ press_public_key: "", mldsa44_key_hash: "0x", active: true, authorized_at: "2026-01-01T00:00:00Z", revoked_at: null }),
    getSubCardEntry: vi.fn().mockImplementation((addr: string) =>
      Promise.resolve(
        addr === server.address
          ? { master_card_address: service.address, registration_log_head: "0x", sub_card_doc_cid: "QmServer", active: true, registered_at: "2026-01-01T00:00:00Z", deregistered_at: null }
          : addr === device.address
            ? { master_card_address: user.address, registration_log_head: "0x", sub_card_doc_cid: "QmDevice", active: true, registered_at: "2026-01-01T00:00:00Z", deregistered_at: null }
            : null
      )
    ),
    getCardEventLog: vi.fn().mockResolvedValue([] as CardChainEvent[]),
    getEasAnnotations: vi.fn().mockResolvedValue([]),
    getDomainRegistration: vi.fn().mockImplementation((domain: string) => {
      if (opts.domainReg === null) return Promise.resolve(null);
      if (domain !== (opts.bindingDomain ?? "example.org")) return Promise.resolve(null);
      return Promise.resolve({ admin_card_address: admin.address, fraud_risk: 0, suspension_expires_at: 0, ...opts.domainReg });
    }),
  };
  const ipfs: IpfsProvider = {
    fetch: vi.fn().mockImplementation((cid: string) => (blobs[cid] ? Promise.resolve(blobs[cid]) : Promise.reject(new Error(`CID not found: ${cid}`)))),
  };

  const verifier = new CardVerifier({
    rpc,
    ipfs,
    trustedRoots: [appRoot.address, userRoot.address],
    appCertificationRoot: appRoot.address,
    loginServiceCertificationRoot: loginBranch.address,
  });
  // Stage 4 reads revocations from the event log, which the tests don't model in
  // detail; inject the service card's update codes directly into verifyCard.
  if (serviceUpdates.length) {
    const original = verifier.verifyCard.bind(verifier);
    verifier.verifyCard = async (address, options) => {
      const r = await original(address, options);
      if (address !== service.address) return r;
      const revoked = serviceUpdates.some((u) => u.update_code >= 800);
      return { ...r, log_updates: [...r.log_updates, ...serviceUpdates], is_currently_valid: revoked ? false : r.is_currently_valid };
    };
  }

  // A signed request and a matching response.
  const now = new Date("2026-11-09T12:05:00Z");
  function makeRequest(over: Partial<AuthenticationRequest> = {}): AuthenticationRequest {
    const unsigned = {
      dcql_query: { credentials: [{ id: "m", format: "mcard" as const, meta: { policies: [{ id: policies.root.kp.address, include_children: true }] } }] },
      expires_at: "2026-11-09T12:10:00Z",
      nonce: b64(new Uint8Array(32).fill(1)),
      purpose: "Log in",
      requester_card: server.address,
      requester_pubkey: b64(server),
      response_mode: "form_post" as const,
      response_uri: "https://forum.example.org/login/cb",
      state: b64(new Uint8Array(16).fill(2)),
      statement: "Log in to https://forum.example.org",
      version: "2" as const,
      ...over,
    };
    const { request_signature: _ignored, ...toSign } = unsigned as AuthenticationRequest;
    return { ...toSign, request_signature: sign(server.secretKey, toSign) } as AuthenticationRequest;
  }
  function makeResponse(request: AuthenticationRequest, over: { content?: Record<string, unknown>; payload?: Record<string, unknown>; signer?: Kp } = {}): AuthenticationResponse {
    const payload = {
      type: "auth_response",
      content: {
        audience: "https://forum.example.org",
        nonce: request.nonce,
        request_hash: requestHash(request),
        state: request.state,
        statement: request.statement,
        ...over.content,
      },
      protocol_version: "0.1",
      recipients: [service.address],
      senders: [user.address],
      timestamp: "2026-11-09T12:04:00Z",
      ...over.payload,
    };
    const signer = over.signer ?? device;
    const signature = Buffer.from(ml_dsa44.sign(canonicalize(payload), signer.secretKey)).toString("base64url");
    return { state: request.state, signed_statement: { payload: payload as never, signatures: [{ public_key: b64(signer), signature }] } };
  }

  return { verifier, rpc, ipfs, keys: { appRoot, loginBranch, service, server, admin, user, device, walletCard, issuer, policyRoot: policyRootKp, policyChild: policyChildKp }, policies, now, makeRequest, makeResponse, b64 };
}
