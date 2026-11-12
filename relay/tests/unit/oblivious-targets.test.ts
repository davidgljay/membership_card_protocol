import { describe, it, expect, vi, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getObliviousTarget, loadObliviousTargets, OBLIVIOUS_TARGET_KINDS } from "../../src/utils/oblivious_targets.js";

function registryFile(targets: unknown[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oblivious-targets-"));
  const file = path.join(dir, "targets.json");
  fs.writeFileSync(file, JSON.stringify({ targets }));
  return file;
}

afterEach(() => vi.restoreAllMocks());

describe("oblivious target registry: the notary host as a third destination kind (notary_host.md §6)", () => {
  it("lists the three kinds", () => {
    expect([...OBLIVIOUS_TARGET_KINDS]).toEqual(["wallet_service", "press", "notary_host"]);
  });

  it("registers a notary host next to a wallet service and a press; each target_id maps to its own gateway", () => {
    loadObliviousTargets(registryFile([
      { target_id: "ws-1", ohttp_gateway_url: "https://wallet.example/ohttp/gateway", kind: "wallet_service" },
      { target_id: "press-1", ohttp_gateway_url: "https://press.example/ohttp/gateway", kind: "press" },
      { target_id: "notary-a", ohttp_gateway_url: "https://notary.example/ohttp/gateway", kind: "notary_host" },
      { target_id: "legacy", ohttp_gateway_url: "https://old.example/ohttp/gateway" },
    ]));
    expect(getObliviousTarget("notary-a")).toEqual({ target_id: "notary-a", ohttp_gateway_url: "https://notary.example/ohttp/gateway", kind: "notary_host" });
    expect(getObliviousTarget("ws-1")?.kind).toBe("wallet_service");
    expect(getObliviousTarget("legacy")?.kind).toBeUndefined(); // existing registries without `kind` keep working
    expect(getObliviousTarget("unknown")).toBeUndefined();
  });

  it("rejects an unknown kind, a non-https gateway and a duplicate target_id", () => {
    const exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => { throw new Error(`exit ${code}`); }) as never);
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => loadObliviousTargets(registryFile([{ target_id: "n", ohttp_gateway_url: "https://n.example/g", kind: "mixnode" }]))).toThrow("exit 1");
    expect(() => loadObliviousTargets(registryFile([{ target_id: "n", ohttp_gateway_url: "http://n.example/g", kind: "notary_host" }]))).toThrow("exit 1");
    expect(() => loadObliviousTargets(registryFile([{ target_id: "n", ohttp_gateway_url: "https://a/g" }, { target_id: "n", ohttp_gateway_url: "https://b/g" }]))).toThrow("exit 1");
    expect(exit).toHaveBeenCalledTimes(3);
  });
});
