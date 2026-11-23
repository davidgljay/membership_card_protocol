/**
 * Job intake's policy read (notary_host.md §7): the `notary` section and `approved_notaries` of a policy at a state, from the
 * policy's plain genesis document and the card state at `stateCid`. A courtesy check only: the enclave runs algorithm R
 * itself, so nothing here is trusted. Used with the simulated and the production IPFS alike.
 */
import { createDecipheriv } from "node:crypto";
import { hkdf } from "@noble/hashes/hkdf";
import { sha3_256 } from "@noble/hashes/sha3";
import { b64uDecode } from "@membership-card-protocol/wallet-sdk/notary-types";
import type { NotarySection } from "@membership-card-protocol/verifier/notary";
import type { IpfsService, PolicyReader } from "../services.js";

type Json = Record<string, unknown>;

export function policyReader(ipfs: IpfsService): PolicyReader {
  return {
    async notary(policyId, stateCid) {
      const plain = await ipfs.fetch(policyId);
      if (!plain) return null;
      let genesis: Json;
      try { genesis = JSON.parse(new TextDecoder().decode(plain)) as Json; } catch { return null; }
      const pub = typeof genesis["recipient_pubkey"] === "string" ? b64uDecode(genesis["recipient_pubkey"] as string) : null;
      if (!pub) return null;
      const key = hkdf(sha3_256, pub, undefined, new TextEncoder().encode("card-content-v1"), 32);
      const open = async (cid: string): Promise<Json | null> => {
        const b = await ipfs.fetch(cid);
        if (!b) return null;
        try {
          const d = createDecipheriv("aes-256-gcm", key, b.subarray(0, 12));
          d.setAuthTag(b.subarray(b.length - 16));
          return JSON.parse(Buffer.concat([d.update(b.subarray(12, b.length - 16)), d.final()]).toString()) as Json;
        } catch { try { return JSON.parse(new TextDecoder().decode(b)) as Json; } catch { return null; } }
      };
      const state = await open(stateCid);
      if (!state) return null;
      const doc: Json = { ...genesis, ...((state["card_state"] as Json | undefined) ?? (state["entry_type"] ? {} : state)) };
      return { notary: doc["notary"] as NotarySection, approvedNotaries: (doc["approved_notaries"] as string[] | undefined) ?? [] };
    },
  };
}
