/**
 * In-process dispatcher for the two routes reachable **only** through the gateway (notary_host.md §5;
 * oblivious_transport.md §Notary Host Destination): `GET /jobs/{hash}/announcement` and `POST /jobs/{hash}/inputs`.
 * Anything else is `NOT_REACHABLE`. A direct HTTP request to these paths is refused by the route files
 * (`NH_DIRECT_FORBIDDEN`), so the only way in is a decapsulated envelope.
 */
import type { HostContext } from "./context.js";
import { HostError } from "./context.js";
import { handleGetAnnouncement } from "./handlers/jobs.js";
import { handleSubmitInput } from "./handlers/inputs.js";
import type { OhttpEnvelope, OhttpResponseEnvelope } from "./ohttp-gateway.js";

const PATH = /^\/jobs\/([A-Za-z0-9_-]{43})\/(announcement|inputs)$/;

const encode = (body: unknown) => (body === undefined ? undefined : Buffer.from(JSON.stringify(body), "utf-8").toString("base64url"));
const respond = (status: number, body: unknown): OhttpResponseEnvelope => { const b = encode(body); return b === undefined ? { status, headers: {} } : { status, headers: {}, body: b }; };

export async function dispatch(envelope: OhttpEnvelope, ctx: HostContext): Promise<OhttpResponseEnvelope> {
  const m = PATH.exec(envelope.path);
  const route = m && `${envelope.method} ${m[2]}`;
  if (!m || (route !== "GET announcement" && route !== "POST inputs"))
    return respond(404, { error: "NOT_REACHABLE", message: `Not reachable through the gateway: ${envelope.method} ${envelope.path}` });
  const jobHash = m[1]!;
  try {
    if (route === "GET announcement") return respond(200, await handleGetAnnouncement(ctx, jobHash));
    const body = envelope.body ? JSON.parse(Buffer.from(envelope.body, "base64url").toString("utf-8")) : undefined;
    return respond(200, await handleSubmitInput(ctx, jobHash, body));
  } catch (e) {
    if (e instanceof HostError) return respond(e.status, { error: e.code, message: e.message });
    if (e instanceof SyntaxError) return respond(400, { error: "INPUT_MALFORMED", message: "body is not JSON" });
    throw e;
  }
}
