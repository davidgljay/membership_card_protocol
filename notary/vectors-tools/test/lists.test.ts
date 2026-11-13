/**
 * Algorithm L cross-language check (code-plan §7.2 `lists/`): the TypeScript `verifyListApproval` must give the same
 * verdict and code as the Rust broker for every Rust-produced case in `notary/vectors/lists/cases.json`.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { b64uDecode, verifyListApproval } from "@membership-card-protocol/verifier/notary";
import type { GovernanceKeyset, ListVersion } from "@membership-card-protocol/verifier/notary";

const file = JSON.parse(readFileSync(new URL("../../vectors/lists/cases.json", import.meta.url), "utf8")) as {
  cases: { id: string; list: "accepted_runtimes" | "program_allowlist"; list_card: string; keyset: { keys: string[]; quorum: number; version: number; key_scheme: 0 | 1 };
    history: { value: unknown[]; approval_text: string | null }[]; expect: { ok: true; list_version: number; single_operator_quorums: string } | { ok: false; code: string } }[];
};

describe("algorithm L: Rust and TypeScript agree", () => {
  it("has the full case set", () => expect(file.cases.length).toBeGreaterThanOrEqual(20));
  for (const c of file.cases) {
    it(c.id, () => {
      const keyset: GovernanceKeyset = { ...c.keyset, keys: c.keyset.keys.map((k) => b64uDecode(k)) };
      const history: ListVersion[] = c.history.map((h) => ({ value: h.value, approvalText: h.approval_text ?? undefined }));
      const r = verifyListApproval({ list: c.list, listCard: c.list_card, history, keyset });
      expect(r.ok ? { ok: true, list_version: r.listVersion, single_operator_quorums: r.singleOperatorQuorums } : { ok: false, code: r.code }).toEqual(c.expect);
    });
  }
});
