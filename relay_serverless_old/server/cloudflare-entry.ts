// Hand-rolled Cloudflare Worker entry — the deployment's actual `main`
// under wrangler.toml, NOT Nitro's generated `.output/server/index.mjs`
// used directly.
//
// WHY THIS EXISTS (same rationale as relay/spike-do-ws/README.md,
// carried into the real build for Phase 2): Nitro's built-in
// `cloudflare-durable` preset hardcodes a single fixed Durable Object
// instance name with no per-request resolution, so it cannot address one
// DO per UUID (`GET /ws/{uuid}`) or one DO per device_credential
// (`GET /sse`) out of the box. crossws's currently-published version has
// also dropped the `cloudflare-durable` adapter's export path. Both
// findings were confirmed again at the start of Phase 2 (re-checked per
// the Phase 1 summary's recommendation #3) and neither has changed. This
// file is the permanent version of the spike's `worker.ts` pattern:
//   - Ordinary HTTP requests (everything except GET /ws/:uuid and
//     GET /sse) are delegated to Nitro's generated fetch handler
//     unmodified — this is where all of Phase 2's portable HTTP-handler
//     code (register/deliver/pending/ack/health, server/api/**) actually
//     runs, completely untouched by this file.
//   - GET /ws/:uuid and GET /sse upgrade requests are intercepted HERE,
//     BEFORE reaching Nitro, because Nitro has no way to route them to a
//     per-key Durable Object. This file does the exact same Redis-side
//     validation as server/utils/ws-upgrade.ts / sse-upgrade.ts (imported
//     directly, not duplicated — see those files' module docs) and then
//     forwards to the correct DO instance via idFromName(...), matching
//     relay_data_model.md §10.3's required ordering (Redis validation
//     first, DO only invoked after that succeeds).
//   - The two DO classes (server/do/uuid-connection.ts,
//     server/do/device-channel.ts) are re-exported here because Cloudflare
//     requires Durable Object classes to be named exports of the Worker's
//     main module — this is a Workers platform requirement, not a Nitro
//     integration detail.
//
// wrangler.toml's `main` points here, not at `.output/server/index.mjs`,
// specifically so this file's Nitro import below picks up Nitro's build
// output as a library dependency rather than this being Nitro's own entry.

export { UuidConnection } from './do/uuid-connection';
export { DeviceChannel } from './do/device-channel';

import { RedisClient } from './utils/redis/resp-client';
import { validateAndActivateUuid } from './utils/ws-upgrade';
import { validateSseCredential } from './utils/sse-upgrade';

// Nitro's generated Cloudflare module-worker handler — built by
// `npm run build:cloudflare` into .output/server/index.mjs. This import
// path is resolved at deploy time once that build has run; see
// PROVISIONING.md / the Phase 2 report for the exact build+deploy
// sequence. Typed loosely here since Nitro's generated output has no
// published .d.ts for this shape — `@ts-ignore` (not `@ts-expect-error`)
// deliberately, since whether this resolves to a type error or a "cannot
// find module" error depends on whether `.output/` exists yet at
// typecheck time (it doesn't in a clean checkout/CI step ordering that
// typechecks before building), and `@ts-expect-error` would itself error
// ("unused directive") in whichever of those two states doesn't produce
// an error.
// @ts-ignore
import nitroHandlerImport from '../.output/server/index.mjs';

// The @ts-ignore above only suppresses the diagnostic on the import
// specifier itself (unresolvable module / no .d.ts) — it does not carry
// forward to later usages of the imported value, which TS otherwise
// widens to `{}` when the module can't be resolved at typecheck time.
// This local cast is what actually makes `nitroHandler.fetch(...)` and
// `nitroHandler.scheduled?.(...)` below typecheck in both states (`.output`
// present or absent), consistent with the comment above describing why a
// single suppression mechanism can't cover both cases.
interface NitroCloudflareHandler {
  fetch(request: Request, env: Env, ctx: unknown): Promise<Response>;
  scheduled?(controller: unknown, env: Env, ctx: unknown): unknown;
}
const nitroHandler = nitroHandlerImport as unknown as NitroCloudflareHandler;

interface Env {
  REDIS_PRIMARY_URL: string;
  UUID_CONNECTION: {
    idFromName(name: string): unknown;
    get(id: unknown): { fetch(req: Request): Promise<Response> };
  };
  DEVICE_CHANNEL: {
    idFromName(name: string): unknown;
    get(id: unknown): { fetch(req: Request): Promise<Response> };
  };
  [key: string]: unknown;
}

function extractPathSegment(pathname: string, prefix: string): string | null {
  if (!pathname.startsWith(prefix)) return null;
  const rest = pathname.slice(prefix.length);
  return rest.length > 0 ? rest : null;
}

async function handleWsUpgrade(request: Request, env: Env, uuid: string): Promise<Response> {
  const redis = new RedisClient({ url: env.REDIS_PRIMARY_URL });
  let validation;
  try {
    validation = await validateAndActivateUuid(redis, uuid);
  } finally {
    await redis.close();
  }

  if (!validation.ok) {
    // relay.md §7.3's WebSocket close codes — since this is a rejected
    // upgrade, respond with a plain HTTP error (the close-code semantics
    // apply once a socket exists; for a rejected upgrade we never create
    // one, so an HTTP status is what a client actually observes).
    const status =
      validation.wsCloseCode === 4000 ? 400 : validation.wsCloseCode === 4004 ? 404 : 410;
    return Response.json({ error: validation.errorCode, message: validation.message }, { status });
  }

  // Step 5 (relay_data_model.md §10.3): forward to the UUID's DO, only
  // now that Redis validation succeeded.
  const id = env.UUID_CONNECTION.idFromName(uuid);
  const stub = env.UUID_CONNECTION.get(id);
  const doUrl = new URL(request.url);
  doUrl.searchParams.set('uuid', uuid);
  return stub.fetch(new Request(doUrl, request));
}

async function handleSseUpgrade(request: Request, env: Env): Promise<Response> {
  const credentialHeader = request.headers.get('authorization');
  const match = credentialHeader ? /^Bearer\s+(.+)$/i.exec(credentialHeader) : null;
  const credential = match?.[1] ?? null;

  const redis = new RedisClient({ url: env.REDIS_PRIMARY_URL });
  let validation;
  try {
    validation = await validateSseCredential(redis, credential);
  } finally {
    await redis.close();
  }

  if (!validation.ok) {
    return Response.json(
      { error: validation.errorCode, message: validation.message },
      { status: 401 }
    );
  }

  const id = env.DEVICE_CHANNEL.idFromName(credential as string);
  const stub = env.DEVICE_CHANNEL.get(id);
  const doUrl = new URL(request.url);
  doUrl.searchParams.set('device_credential', credential as string);
  return stub.fetch(new Request(doUrl, request));
}

export default {
  async fetch(request: Request, env: Env, ctx: unknown): Promise<Response> {
    const url = new URL(request.url);
    const isUpgrade = request.headers.get('upgrade') === 'websocket';

    if (isUpgrade) {
      const wsUuid = extractPathSegment(url.pathname, '/ws/');
      if (wsUuid) {
        return handleWsUpgrade(request, env, wsUuid);
      }
      if (url.pathname === '/sse') {
        return handleSseUpgrade(request, env);
      }
    }

    // Everything else — including the non-upgrade GET /sse fallback error
    // some HTTP clients might send, and all of register/deliver/pending/
    // ack/health/notify — goes through Nitro's generated handler
    // unmodified.
    return nitroHandler.fetch(request, env, ctx);
  },
  scheduled: (controller: unknown, env: Env, ctx: unknown) =>
    nitroHandler.scheduled?.(controller, env, ctx),
};
