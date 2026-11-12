/**
 * Card login entry points — card_verifier.md §6.3 verifyLoginResponse and
 * §6.4 verifyServerCard. Error codes: process_specs/card_login.md §Error Codes.
 */

import { keccak256, base64UrlToBytes } from "../crypto.js";
import { verifyStage2 } from "../stages/stage2.js";
import type {
  RpcProvider,
  IpfsProvider,
  VerifierConfig,
  CardVerificationResult,
  EnvelopeVerificationResult,
  SignatureVerificationResult,
  SignedMessageEnvelope,
  VerifyCardOptions,
} from "../types.js";
import { requestHash, httpsOrigin } from "./encoding.js";
import { readCardFields, readSubCardDocument, matchMcardQuery, normAddress } from "./chain.js";
import { checkDomainBinding } from "./domainBinding.js";
import type { AuthenticationRequest, AuthenticationResponse, AuthResponseContent } from "./types.js";

export interface LoginDeps {
  rpc: RpcProvider;
  ipfs: IpfsProvider;
  config: Pick<VerifierConfig, "appCertificationRoot" | "loginServiceCertificationRoot" | "maxChainDepth">;
  verifyCard(address: string, options?: VerifyCardOptions): Promise<CardVerificationResult>;
  verifyEnvelope(envelope: SignedMessageEnvelope): Promise<EnvelopeVerificationResult>;
}

// ─── §6.4 verifyServerCard ───────────────────────────────────────────────────

export type LoginWarning = "LOGIN_WARN_SERVICE_NEGATIVE" | "LOGIN_WARN_DOMAIN_MONITORED" | "LOGIN_WARN_SERVICE_ROTATED";

export interface VerifyServerCardOptions {
  /** Origin the request's answer goes to (the response_uri origin). */
  origin: string;
  /** Capability the server card must hold. Default "auth_request". */
  requiredCapability?: string;
  now?: string;
}

export type ServerCardVerificationResult =
  | {
      valid: true;
      server_card: string;
      login_service_card: string;
      login_service_card_pubkey: string;
      domain: string;
      login_service: CardVerificationResult;
      warnings: LoginWarning[];
    }
  | { valid: false; code: string; reason: string };

const fail = (code: string, reason: string) => ({ valid: false as const, code, reason });

export async function verifyServerCard(
  deps: LoginDeps,
  serverCardPubkey: string,
  options: VerifyServerCardOptions
): Promise<ServerCardVerificationResult> {
  const now = options.now ? new Date(options.now) : new Date();
  let pk: Uint8Array;
  try {
    pk = new Uint8Array(base64UrlToBytes(serverCardPubkey));
  } catch {
    return fail("LOGIN_REQUESTER_NOT_SERVER_CARD", "server card public key is not base64url");
  }
  const serverCard = keccak256(pk);

  // Step 1 — Stage 2 as a sub-card, then the server-card shape.
  const s2 = await verifyStage2(pk, deps.rpc, deps.ipfs, deps.config);
  if (s2.scope_clean !== true || !s2.sub_card_doc) {
    const codes = s2.errors.map((e) => e.code);
    const reason = codes.join(", ") || "not a sub-card";
    if (codes.includes("APP_CARD_CHAIN_NOT_TRUSTED")) return fail("LOGIN_SERVICE_NOT_CERTIFIED", reason);
    if (codes.includes("SUB_CARD_INACTIVE")) return fail("LOGIN_SERVICE_REVOKED", reason);
    return fail("LOGIN_REQUESTER_NOT_SERVER_CARD", reason);
  }
  const doc = s2.sub_card_doc;
  if (s2.app_card_branch !== "login_service") {
    return fail("LOGIN_SERVICE_NOT_CERTIFIED", "the certifying card is not under the login service branch");
  }
  if (normAddress(doc.app_card) !== normAddress(doc.holder_primary_card)) {
    return fail("LOGIN_REQUESTER_NOT_SERVER_CARD", "app_card differs from holder_primary_card");
  }
  if (doc.attestation_level !== "S1") {
    return fail("LOGIN_REQUESTER_NOT_SERVER_CARD", `attestation_level is ${doc.attestation_level}, expected S1`);
  }
  const capability = options.requiredCapability ?? "auth_request";
  if (!doc.capabilities.includes(capability)) {
    return fail("LOGIN_REQUESTER_NOT_SERVER_CARD", `server card lacks the ${capability} capability`);
  }
  if (doc.valid_until && Date.parse(doc.valid_until) <= now.getTime()) {
    return fail("LOGIN_SERVICE_REVOKED", "server card has expired");
  }

  // Step 2 — the login service card's own status.
  const serviceCard = normAddress(doc.holder_primary_card);
  const service = await deps.verifyCard(serviceCard, { pubkey: doc.holder_primary_card_pubkey });
  if (service.chain_reaches_trusted_root !== true) {
    return fail("LOGIN_SERVICE_NOT_CERTIFIED", "login service card chain does not reach a trusted root");
  }
  if (service.is_currently_valid !== true) {
    return fail("LOGIN_SERVICE_REVOKED", "login service card or an ancestor is revoked");
  }
  const ownUpdates = service.log_updates.filter((u) => normAddress(u.card_address) === serviceCard);
  if (ownUpdates.some((u) => u.update_code === 101)) {
    return fail("LOGIN_SERVICE_KEY_COMPROMISED", "login service card was rotated for possible key compromise (code 101)");
  }

  // Steps 3–5 — domain binding.
  const fields = await readCardFields(doc.holder_primary_card_pubkey, deps);
  const binding = await checkDomainBinding({
    binding: fields?.fields["domain_binding"],
    loginServiceCardAddress: serviceCard,
    origin: options.origin,
    rpc: deps.rpc,
    isCardCurrentlyValid: async (address) => (await deps.verifyCard(address)).is_currently_valid !== false,
    now,
  });
  if (!binding.ok) return fail(binding.code, binding.reason);

  // Step 6 — warnings.
  const warnings: LoginWarning[] = [];
  if (ownUpdates.some((u) => u.update_code >= 600 && u.update_code < 800)) warnings.push("LOGIN_WARN_SERVICE_NEGATIVE");
  if (binding.monitored) warnings.push("LOGIN_WARN_DOMAIN_MONITORED");
  if (ownUpdates.some((u) => u.update_code === 100)) warnings.push("LOGIN_WARN_SERVICE_ROTATED");

  return {
    valid: true,
    server_card: serverCard,
    login_service_card: serviceCard,
    login_service_card_pubkey: doc.holder_primary_card_pubkey,
    domain: binding.domain,
    login_service: service,
    warnings,
  };
}

// ─── §6.3 verifyLoginResponse ────────────────────────────────────────────────

export interface VerifyLoginResponseInput {
  /** form_post: the AuthenticationResponse wrapper. mcard_message: the received envelope. */
  response: AuthenticationResponse | SignedMessageEnvelope;
  /** The AuthenticationRequest exactly as the site issued it. */
  request: AuthenticationRequest;
  /** The site's own origin, e.g. "https://example.com". */
  expectedOrigin: string;
  now?: string;
  maxResponseAgeSeconds?: number;
  clockSkewSeconds?: number;
}

export type LoginVerificationResult =
  | {
      valid: true;
      presented_card: string;
      login_service_card: string;
      matched_policy: string;
      verification: SignatureVerificationResult;
    }
  | { valid: false; code: string; reason: string; verification?: SignatureVerificationResult };

const REQUEST_MAX_LIFETIME_MS = 10 * 60 * 1000;

export async function verifyLoginResponse(deps: LoginDeps, input: VerifyLoginResponseInput): Promise<LoginVerificationResult> {
  const { request } = input;
  const nowMs = input.now ? Date.parse(input.now) : Date.now();
  const skewMs = (input.clockSkewSeconds ?? 60) * 1000;
  const maxAgeMs = (input.maxResponseAgeSeconds ?? 300) * 1000;

  const wrapperState = "signed_statement" in input.response ? input.response.state : undefined;
  const envelope = "signed_statement" in input.response ? input.response.signed_statement : input.response;
  const payload = envelope.payload as Record<string, unknown>;
  const content = (payload["content"] ?? {}) as Partial<AuthResponseContent>;

  // 1. type
  if (payload["type"] !== "auth_response") return fail("LOGIN_WRONG_TYPE", `type is ${String(payload["type"])}`);
  // 2. state (signed and unsigned copies)
  if (content.state !== request.state || (wrapperState !== undefined && wrapperState !== request.state)) {
    return fail("LOGIN_STATE_MISMATCH", "state does not match the issued request");
  }
  // 3. nonce, statement
  if (content.nonce !== request.nonce) return fail("LOGIN_NONCE_MISMATCH", "nonce does not match");
  if (content.statement !== request.statement) return fail("LOGIN_STATEMENT_MISMATCH", "statement does not match");
  // 4. request hash
  if (content.request_hash !== requestHash(request)) return fail("LOGIN_REQUEST_HASH_MISMATCH", "request_hash does not match the issued request");
  // 5. audience
  const requestOrigin = httpsOrigin(request.response_uri);
  if (!requestOrigin || content.audience !== input.expectedOrigin || requestOrigin !== input.expectedOrigin) {
    return fail("LOGIN_AUDIENCE_MISMATCH", `audience ${String(content.audience)} is not ${input.expectedOrigin}`);
  }
  // 6. recipients = [login service card]; exactly one sender
  const server = await readSubCardDocument(request.requester_pubkey, deps);
  const loginServiceCard = typeof server?.["holder_primary_card"] === "string" ? normAddress(server["holder_primary_card"] as string) : null;
  const recipients = payload["recipients"];
  if (!loginServiceCard || !Array.isArray(recipients) || recipients.length !== 1 || normAddress(String(recipients[0])) !== loginServiceCard) {
    return fail("LOGIN_RECIPIENT_MISMATCH", "recipients must be exactly the login service card");
  }
  const senders = payload["senders"];
  if (!Array.isArray(senders) || senders.length !== 1 || typeof senders[0] !== "string") {
    return fail("LOGIN_SENDER_MISMATCH", "senders must contain exactly one card");
  }
  const presented = normAddress(senders[0]);
  // 7. freshness
  const ts = Date.parse(String(payload["timestamp"]));
  const expires = Date.parse(request.expires_at);
  if (
    Number.isNaN(ts) ||
    ts > expires + skewMs ||
    ts < expires - REQUEST_MAX_LIFETIME_MS - skewMs ||
    nowMs - ts > maxAgeMs + skewMs
  ) {
    return fail("LOGIN_RESPONSE_STALE", "response timestamp is outside the allowed window");
  }
  // 8. envelope signature, sub-card link, chain, revocation
  const env = await deps.verifyEnvelope(envelope);
  const sig = env.signatures[0];
  if (!sig || env.signatures.length !== 1) return fail("LOGIN_PRESENTED_CARD_INVALID", "expected exactly one signature");
  if (sig.signature_valid !== true || sig.scope_clean === false || sig.chain_reaches_trusted_root !== true || sig.is_currently_valid !== true) {
    return { ...fail("LOGIN_PRESENTED_CARD_INVALID", sig.errors[0]?.code ?? "verification failed"), verification: sig };
  }
  const signedAs = normAddress(sig.chain_card_addresses[0] ?? sig.signer_card);
  if (signedAs !== presented) {
    return { ...fail("LOGIN_SENDER_MISMATCH", `signed by ${signedAs}, senders says ${presented}`), verification: sig };
  }
  // 9. DCQL match on the presented card
  const presentedPubkey = sig.chain?.[0]?.public_key;
  const presentedFields = presentedPubkey
    ? (await readCardFields(presentedPubkey, deps))?.fields
    : (sig.chain?.[0]?.card_content as Record<string, unknown> | undefined);
  const query = request.dcql_query.credentials[0];
  if (!presentedFields || !query) return { ...fail("LOGIN_CARD_NOT_ACCEPTED", "presented card could not be read"), verification: sig };
  const match = await matchMcardQuery(presentedFields, query, deps, presented);
  if (!match.matched) return { ...fail("LOGIN_CARD_NOT_ACCEPTED", match.reason), verification: sig };

  return { valid: true, presented_card: presented, login_service_card: loginServiceCard, matched_policy: match.policy, verification: sig };
}
