/**
 * In-process dispatcher for the six sensitive endpoints reachable through
 * the oblivious path (client-sdk implementation plan Step 1.4d). Maps a
 * decapsulated `OhttpEnvelope` to the same `handleX(ctx, body)` handler
 * function `server/api/**` already calls — a direct function call, not a
 * second HTTP round-trip, and no refactor of those handlers was needed
 * (they already took plain input, not an H3Event).
 *
 * Only these six endpoints are reachable through the gateway; a path
 * outside this set (e.g. `/press`) is rejected rather than silently
 * forwarded — the public read endpoints stay direct-HTTPS-only, per
 * OQ-SDK-4's press extension.
 */

import type { PressContext } from './context.js';
import { handleIssue, handleIssueFinalize } from './handlers/issue.js';
import { handleOpenOfferClaim } from './handlers/open-offer.js';
import { handleUpdate } from './handlers/update.js';
import { handleSubCardRegister, handleSubCardDeregister } from './handlers/sub-card.js';
import type { OhttpEnvelope, OhttpResponseEnvelope } from './ohttp-gateway.js';

function decodeBody<T>(body: string | undefined): T | undefined {
  if (!body) return undefined;
  return JSON.parse(Buffer.from(body, 'base64url').toString('utf-8')) as T;
}

function encodeBody(body: unknown): string | undefined {
  if (body === null || body === undefined) return undefined;
  return Buffer.from(JSON.stringify(body), 'utf-8').toString('base64url');
}

function ok(status: number, body: unknown): OhttpResponseEnvelope {
  const encoded = encodeBody(body);
  return encoded === undefined ? { status, headers: {} } : { status, headers: {}, body: encoded };
}

function fail(status: number, error: string, message: string): OhttpResponseEnvelope {
  return ok(status, { error, message });
}

const ROUTES: Record<string, (ctx: PressContext, body: unknown) => Promise<unknown>> = {
  'POST /issue': (ctx, body) => handleIssue(ctx, body as never),
  'POST /issue/finalize': (ctx, body) => handleIssueFinalize(ctx, body as never),
  'POST /open-offer/claim': (ctx, body) => handleOpenOfferClaim(ctx, body as never),
  'POST /update': (ctx, body) => handleUpdate(ctx, body as never),
  'POST /sub-card/register': (ctx, body) => handleSubCardRegister(ctx, body as never),
  'POST /sub-card/deregister': (ctx, body) => handleSubCardDeregister(ctx, body as never),
};

export async function dispatch(
  envelope: OhttpEnvelope,
  ctx: PressContext
): Promise<OhttpResponseEnvelope> {
  const route = ROUTES[`${envelope.method} ${envelope.path}`];
  if (!route) {
    return fail(
      404,
      'NOT_REACHABLE',
      `Not reachable through the OHTTP gateway: ${envelope.method} ${envelope.path}`
    );
  }

  try {
    const body = decodeBody(envelope.body);
    const result = await route(ctx, body);
    return ok(200, result);
  } catch (err: unknown) {
    const code = (err as { pressCode?: string }).pressCode;
    if (code) {
      return fail(400, code, (err as Error).message);
    }
    throw err;
  }
}
