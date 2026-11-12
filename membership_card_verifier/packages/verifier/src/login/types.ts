/**
 * Card login object types — protocol-objects.md §8, §9, §17, §18, §19.
 * Shared by app-sdk, wallet-sdk, and the login router (re-exported from the
 * package index). Field names and optionality follow the spec exactly; optional
 * fields are omitted when absent, never set to null (RFC 8785 convention).
 */

import type { SignedMessageEnvelope } from "../types.js";

/** A card predicate expression (card_protocol_spec.md §The Predicate System). */
export type CardPredicate = Record<string, unknown>;

/** One accepted policy in an `mcard` DCQL query (protocol-objects.md §8.1). */
export interface McardPolicyRef {
  /** Registry address (card pointer) of the policy card. */
  id: string;
  include_children: boolean;
}

export interface McardCredentialQuery {
  id: string;
  format: "mcard";
  meta: {
    policies: McardPolicyRef[];
    predicate?: CardPredicate;
  };
}

export interface DcqlQuery {
  /** Exactly one entry in v2. */
  credentials: McardCredentialQuery[];
}

export type ResponseMode = "form_post" | "mcard_message";

/** protocol-objects.md §8 — signed by the site's server card. */
export interface AuthenticationRequest {
  context?: Record<string, string>;
  dcql_query: DcqlQuery;
  expires_at: string;
  nonce: string;
  purpose: string;
  request_signature: string;
  requester_card: string;
  requester_pubkey: string;
  response_mode: ResponseMode;
  response_uri: string;
  state: string;
  statement: string;
  version: "2";
  wallet_nonce?: string;
}

/** An AuthenticationRequest before `request_signature` is added. */
export type UnsignedAuthenticationRequest = Omit<AuthenticationRequest, "request_signature">;

/** protocol-objects.md §9 — `content` of an `auth_response` envelope. */
export interface AuthResponseContent {
  audience: string;
  nonce: string;
  request_hash: string;
  state: string;
  statement: string;
}

/** protocol-objects.md §9 — the form_post wrapper. */
export interface AuthenticationResponse {
  state: string;
  signed_statement: SignedMessageEnvelope;
}

/** protocol-objects.md §17 — stored in a login service card's `domain_binding`. */
export interface DomainBindingAttestation {
  admin_card: string;
  admin_card_pubkey: string;
  admin_signature: string;
  domain: string;
  issued_at: string;
  login_service_card: string;
  login_service_card_pubkey: string;
}

/** protocol-objects.md §18 — served at /.well-known/membership-login. */
export interface LoginServiceMetadataBody {
  accepts: McardPolicyRef[];
  name: string;
  origin: string;
  response_modes: ResponseMode[];
  server_card: string;
  server_card_pubkey: string;
  start_url: string;
  updated_at: string;
  version: "1";
}

export interface LoginServiceMetadata {
  metadata: LoginServiceMetadataBody;
  signature: string;
}

/** protocol-objects.md §19 — presented to the login router. */
export interface WalletRegistrationTokenBody {
  app_card: string;
  app_card_pubkey: string;
  expires_at: string;
  handler_url: string;
  icon?: string;
  issued_at: string;
  name: string;
  router_origin: string;
  version: "1";
}

export interface WalletRegistrationToken {
  token: WalletRegistrationTokenBody;
  signature: string;
}

/** protocol-objects.md §2 — one entry of a policy's `preferred_services`. */
export interface PreferredService {
  origin: string;
  name: string;
  icon?: string;
  description?: string;
}
