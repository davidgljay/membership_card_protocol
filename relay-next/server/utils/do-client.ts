// Helper for the stateless Nitro HTTP-handler layer to reach the two DO
// classes (server/do/uuid-connection.ts, server/do/device-channel.ts) via
// ordinary fetch() calls — relay_data_model.md §10.2: "All Redis
// reads/writes happen in the stateless Nitro HTTP-handler layer, which then
// invokes the Durable Object ... via ordinary fetch() calls."
//
// Only usable under the cloudflare/cloudflare-module preset, where the DO
// namespace bindings (UUID_CONNECTION, DEVICE_CHANNEL — see wrangler.toml)
// exist on the Cloudflare env. Under node-server there is no Durable Object
// runtime at all (strategic-plan.md Goal 3: the DO-backed connection layer
// is explicitly NOT part of the cross-platform portability claim) — callers
// (server/api/deliver/[uuid].post.ts) branch on whether these bindings are
// present and fall back to "no live connection" when they are not, which is
// the correct behavior under node-server dev anyway (no DO, so no live
// socket could exist).

import type { H3Event } from 'h3';

interface CloudflareDoEnv {
  UUID_CONNECTION?: { idFromName(name: string): unknown; get(id: unknown): { fetch(req: Request): Promise<Response> } };
  DEVICE_CHANNEL?: { idFromName(name: string): unknown; get(id: unknown): { fetch(req: Request): Promise<Response> } };
}

function getCloudflareDoEnv(event: H3Event): CloudflareDoEnv | undefined {
  const ctx = event.context as unknown as { cloudflare?: { env?: CloudflareDoEnv } };
  return ctx.cloudflare?.env;
}

export interface DeliverToConnectionResult {
  delivered: boolean;
}

/** Attempts delivery into an open GET /ws/{uuid} connection, if one exists. */
export async function deliverToUuidConnection(
  event: H3Event,
  uuid: string,
  message: { uuid: string; blob: string }
): Promise<DeliverToConnectionResult> {
  const env = getCloudflareDoEnv(event);
  if (!env?.UUID_CONNECTION) {
    // No DO runtime available (node-server, or DO binding not configured) —
    // correctly reported as "no live connection," never a hard error, since
    // /deliver/{uuid}'s at-least-once guarantee via the message store does
    // not depend on this succeeding (relay_data_model.md §10.3 step 3).
    return { delivered: false };
  }
  const id = env.UUID_CONNECTION.idFromName(uuid);
  const stub = env.UUID_CONNECTION.get(id);
  const res = await stub.fetch(
    new Request('http://internal/internal/deliver', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(message),
    })
  );
  return { delivered: res.ok };
}

/** Attempts delivery into an open GET /sse connection for a device_credential, if one exists. */
export async function deliverToDeviceChannel(
  event: H3Event,
  deviceCredential: string,
  message: { uuid: string; blob: string }
): Promise<DeliverToConnectionResult> {
  const env = getCloudflareDoEnv(event);
  if (!env?.DEVICE_CHANNEL) {
    return { delivered: false };
  }
  const id = env.DEVICE_CHANNEL.idFromName(deviceCredential);
  const stub = env.DEVICE_CHANNEL.get(id);
  const res = await stub.fetch(
    new Request('http://internal/internal/deliver', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(message),
    })
  );
  return { delivered: res.ok };
}
