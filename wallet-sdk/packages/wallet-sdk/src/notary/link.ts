/**
 * Share links for notary jobs (notary_lifecycle.md Phase 3; protocol-objects.md §22):
 * `mcard://notary-job?j=<job_hash>&h=<relay target_id>`.
 *
 * `j` is the job hash (43 base64url characters, 32 bytes); `h` is the relay target id of a host serving the job.
 * Both are untrusted hints: the wallet fetches the announcement and runs algorithm W before doing anything.
 */
import { b64uDecode } from "@membership-card-protocol/verifier/notary";

export interface NotaryJobLink { jobHash: string; relayTargetId: string }
export type ParseLinkResult = { ok: true; link: NotaryJobLink } | { ok: false; reason: string };

const TARGET_RE = /^[A-Za-z0-9._~-]{1,128}$/;

export function buildNotaryJobLink(l: NotaryJobLink): string {
  b64uDecode(l.jobHash, 32);
  if (!TARGET_RE.test(l.relayTargetId)) throw new Error("relay target_id has characters outside A-Za-z0-9._~-");
  return `mcard://notary-job?j=${l.jobHash}&h=${l.relayTargetId}`;
}

export function parseNotaryJobLink(link: string): ParseLinkResult {
  const m = /^mcard:\/\/notary-job\?([^#]*)$/.exec(link);
  if (!m) return { ok: false, reason: "not an mcard://notary-job link" };
  const params = new Map<string, string>();
  for (const part of m[1]!.split("&")) {
    const eq = part.indexOf("=");
    if (eq < 1) return { ok: false, reason: "malformed query" };
    const k = part.slice(0, eq), v = part.slice(eq + 1);
    if (params.has(k)) return { ok: false, reason: `duplicate parameter ${k}` };
    params.set(k, v);
  }
  if (params.size !== 2 || !params.has("j") || !params.has("h")) return { ok: false, reason: "expected exactly j and h" };
  const j = params.get("j")!, h = params.get("h")!;
  try { b64uDecode(j, 32); } catch { return { ok: false, reason: "j is not a 32-byte base64url job hash" }; }
  if (!TARGET_RE.test(h)) return { ok: false, reason: "h is not a valid relay target id" };
  return { ok: true, link: { jobHash: j, relayTargetId: h } };
}


