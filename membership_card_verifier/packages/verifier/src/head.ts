import { aes256gcmDecrypt } from "./crypto.js";
import type { CardDocument, IpfsProvider } from "./types.js";

const decoder = new TextDecoder();

/**
 * Decrypts a card's current head (protocol-objects.md §1, §3). When the head
 * is a LogEntry, returns the card's current field state: the genesis
 * CardDocument (history[0]) overlaid with the entry's `card_state`, so callers
 * can read `ancestry_pubkeys`, `active_subcards`, `domain_binding`, etc. the
 * same way for updated and never-updated cards. The entry's own metadata
 * (`entry_type`, `code`, `revocation`, `history`, `version`, `prev_log_root`)
 * is kept on top, so Stage 4 still sees revocations and update codes.
 */
export async function decryptCardHead(cid: string, contentKey: Uint8Array, ipfs: IpfsProvider): Promise<CardDocument> {
  const head = JSON.parse(decoder.decode(await aes256gcmDecrypt(contentKey, await ipfs.fetch(cid)))) as Record<string, unknown>;
  const isLogEntry = head["entry_type"] === "field_update" || head["entry_type"] === "revocation";
  if (!isLogEntry) return head as CardDocument;
  const history = head["history"];
  const genesisCid = Array.isArray(history) ? (history[0] as string | undefined) : undefined;
  const genesis = genesisCid
    ? (JSON.parse(decoder.decode(await aes256gcmDecrypt(contentKey, await ipfs.fetch(genesisCid)))) as Record<string, unknown>)
    : {};
  const state = (head["card_state"] as Record<string, unknown> | undefined) ?? {};
  // Keep the entry's own metadata: Stage 4 reads entry_type / code /
  // revocation / history from the head to detect revocations and update codes.
  const meta: Record<string, unknown> = {};
  for (const k of ["entry_type", "code", "revocation", "history", "version", "prev_log_root"]) {
    if (head[k] !== undefined) meta[k] = head[k];
  }
  return { ...genesis, ...state, ...meta } as CardDocument;
}
