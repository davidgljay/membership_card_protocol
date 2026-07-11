// POST /ohttp/{target_id} — client-sdk implementation plan Step 1.4b.
// Oblivious-forwarding endpoint: reads the request body as an opaque blob
// (the relay never parses or interprets it — see
// server/utils/oblivious-targets.ts's wire-format note), resolves
// target_id via the oblivious-targets registry, and forwards the blob
// as-is to that target's ohttp_gateway_url. Stateless pass-through, no
// Redis/KV/DO involvement — closer in shape to server/api/deliver/[uuid].post.ts's
// outbound-fetch call than to the stateful UUID-store endpoints.

import { getRequestHeader, readRawBody, setResponseHeader, setResponseStatus, type H3Event } from 'h3';
import { loadObliviousTargets } from '../../utils/oblivious-targets';

export default defineEventHandler(async (event: H3Event) => {
  const targetId = event.context.params?.target_id;
  if (!targetId) {
    setResponseStatus(event, 404);
    return { error: 'NOT_FOUND', message: 'target_id is required' };
  }

  const registry = await loadObliviousTargets(event);
  const target = registry.get(targetId);
  if (!target) {
    setResponseStatus(event, 404);
    return { error: 'NOT_FOUND', message: `Unknown target_id: ${targetId}` };
  }

  const body = await readRawBody(event, false);
  const contentType = getRequestHeader(event, 'content-type') ?? 'application/octet-stream';

  const upstreamResponse = await fetch(target.ohttp_gateway_url, {
    method: 'POST',
    headers: { 'content-type': contentType },
    ...(body ? { body: new Uint8Array(body) } : {}),
  });

  setResponseStatus(event, upstreamResponse.status);
  const upstreamContentType = upstreamResponse.headers.get('content-type');
  if (upstreamContentType) {
    setResponseHeader(event, 'content-type', upstreamContentType);
  }

  return Buffer.from(await upstreamResponse.arrayBuffer());
});
