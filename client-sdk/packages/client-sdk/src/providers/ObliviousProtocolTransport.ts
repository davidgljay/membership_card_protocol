/**
 * The oblivious-relay-backed HTTP client used for every wallet-service-facing
 * call (account creation, `service_secret` retrieval, keyring operations,
 * backup/recovery, sub-card registration/deregistration, UUID
 * registration/deregistration) and every press-facing sensitive/state-changing
 * call (claim submission, offer finalization, update/revocation intents,
 * sub-card registration/deregistration submission) — per OQ-SDK-4's redesign
 * and Goal 7.
 *
 * A request sent via {@link request} is HPKE-encapsulated (RFC 9180) to the
 * destination's published OHTTP key configuration before it ever leaves the
 * device, POSTed as an opaque blob to the relay's oblivious-forwarding
 * endpoint (Step 1.4b), and the response is decapsulated on return. The
 * relay never sees plaintext; the destination never sees the device's IP.
 *
 * Implemented once, in `packages/client-sdk` (pure HTTP + HPKE — no
 * platform-specific implementation needed), and parameterized by a
 * destination descriptor rather than hardcoded to one destination: the
 * wallet service is a single fixed instance per SDK configuration
 * (OQ-SDK-7), while a press's descriptor is resolved per offer/update, since
 * a policy may name multiple approved presses.
 *
 * The oblivious path is the default for every sensitive call — there is no
 * separate "enable privacy mode" step. {@link RequestOptions.bypass} exists
 * for testing, and for the press's public read endpoints (`/press`,
 * `/health`, `/app-gas/:address`), which never go through this transport at
 * all and should use a plain HTTP client instead of this interface.
 */
export interface ObliviousProtocolTransport {
  /**
   * Send a request to `destination`, routed through the oblivious relay by
   * default.
   *
   * @param destination - Which OHTTP key configuration and relay-forwarding
   *   target to encapsulate against. `{ kind: 'wallet_service' }` resolves
   *   to the single wallet-service base URL from SDK config; `{ kind:
   *   'press', baseUrl }` resolves per call, since a policy may name
   *   multiple approved presses.
   * @param options - Request payload, method, path, and transport options.
   * @returns The decapsulated response.
   */
  request(destination: ObliviousDestination, options: RequestOptions): Promise<ObliviousResponse>;
}

export type ObliviousDestination = { kind: 'wallet_service' } | { kind: 'press'; baseUrl: string };

export interface RequestOptions {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  path: string;
  body?: Uint8Array;
  headers?: Record<string, string>;
  /**
   * When `true`, bypass the oblivious-relay path and issue a direct HTTPS
   * request instead, producing an identical application-level result. For
   * testing and for explicit host-app opt-out — never the default.
   */
  bypass?: boolean;
}

export interface ObliviousResponse {
  status: number;
  headers: Record<string, string>;
  body: Uint8Array;
}
