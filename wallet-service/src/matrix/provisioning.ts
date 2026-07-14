/**
 * Shadow Matrix account provisioning (matrix-implementation-plan.md Phase 4
 * Step 15b). Given a card_hash already authenticated by the caller (the H3
 * route calls requireSessionToken(event) and passes the resulting
 * session's card_hash in — this function itself is H3-agnostic, same
 * thin-route/pure-src split as src/routes/accounts-challenge.ts), ensures
 * the one shadow Matrix account that card_hash derives to
 * (deriveMatrixUserId, ./account-id.ts) exists on the homeserver.
 *
 * Registers it via Synapse's Client-Server `POST /register` with
 * `type: "m.login.application_service"`, authenticated as this
 * wallet-service's Application Service (Step 14's as_token) — the
 * mechanism an AS uses to create a user it controls without that user
 * ever choosing a password.
 *
 * Idempotent: Synapse replies 400 `M_USER_IN_USE` if the shadow account
 * already exists. That's treated as success (created: false), not an
 * error, so calling this twice for the same card is a no-op the second
 * time — POST /matrix/token (Step 15c) calls this on every request for
 * exactly that reason.
 *
 * Explicitly NOT built here (or anywhere else in this pass): a
 * card-binding resolver endpoint letting the Synapse policy module ask
 * "which card_hash does this Matrix user ID belong to." That dependency
 * was removed from scope entirely on 2026-07-11 — see
 * specs/process_specs/matrix_join_attestation_and_revocation.md and
 * plans/matrix-implementation-plan.md's decisions section — the
 * join-attestation model replaced it.
 */

import { deriveMatrixUserId } from './account-id.js';
import { readAppServiceAsToken } from './appservice-tokens.js';

export interface ProvisionShadowAccountParams {
  cardHash: string;
  serverName: string;
  synapseBaseUrl: string;
  /** Defaults to reading matrix/secrets/appservice-as-token.txt; override for tests. */
  asToken?: string;
  /** Defaults to the global fetch; override for tests (same convention as src/relay-client.ts). */
  fetchImpl?: typeof fetch;
}

export interface ProvisionShadowAccountResult {
  matrixUserId: string;
  /** false when the shadow account already existed (M_USER_IN_USE) — an idempotent no-op, not a failure. */
  created: boolean;
}

interface SynapseErrorBody {
  errcode?: string;
  error?: string;
}

/** "@card_<hex>:<server_name>" -> "card_<hex>" — Synapse's /register wants a bare localpart, not a full user id. */
function localpart(matrixUserId: string): string {
  const withoutSigil = matrixUserId.startsWith('@') ? matrixUserId.slice(1) : matrixUserId;
  const colonIdx = withoutSigil.indexOf(':');
  return colonIdx === -1 ? withoutSigil : withoutSigil.slice(0, colonIdx);
}

export async function provisionShadowAccount(
  params: ProvisionShadowAccountParams
): Promise<ProvisionShadowAccountResult> {
  const { cardHash, serverName, synapseBaseUrl } = params;
  const asToken = params.asToken ?? readAppServiceAsToken();
  const fetchImpl = params.fetchImpl ?? fetch;

  const matrixUserId = deriveMatrixUserId(cardHash, serverName);

  const res = await fetchImpl(`${synapseBaseUrl}/_matrix/client/v3/register`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${asToken}`,
    },
    body: JSON.stringify({
      type: 'm.login.application_service',
      username: localpart(matrixUserId),
    }),
  });

  if (res.ok) {
    return { matrixUserId, created: true };
  }

  if (res.status === 400) {
    const body = (await res.json().catch(() => null)) as SynapseErrorBody | null;
    if (body?.errcode === 'M_USER_IN_USE') {
      return { matrixUserId, created: false };
    }
  }

  throw new Error(
    `provisionShadowAccount: Synapse /register failed for ${matrixUserId} (status ${res.status}).`
  );
}
