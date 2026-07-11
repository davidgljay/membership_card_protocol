import fs from "node:fs";

export interface ObliviousTargetConfig {
  target_id: string;
  ohttp_gateway_url: string;
}

interface ObliviousTargetsFile {
  targets: ObliviousTargetConfig[];
}

let registry: Map<string, ObliviousTargetConfig> | null = null;
let loadAttempted = false;

/**
 * Loads the oblivious-forwarding target registry from OBLIVIOUS_TARGETS_PATH,
 * if set. This feature is optional — if the env var is unset, the registry
 * stays empty and every target_id lookup returns undefined (the route
 * handler should treat that as "feature disabled" / 404, same as an unknown
 * target_id). Unlike loadAppRegistry, a missing env var here is NOT a fatal
 * startup error.
 */
export function loadObliviousTargets(path: string | undefined): void {
  loadAttempted = true;
  if (!path) {
    registry = new Map();
    console.log("[oblivious-targets] OBLIVIOUS_TARGETS_PATH not set — OHTTP forwarding disabled");
    return;
  }

  let raw: string;
  try {
    raw = fs.readFileSync(path, "utf-8");
  } catch (err) {
    console.error(`Failed to read oblivious-targets registry at ${path}:`, err);
    process.exit(1);
  }

  let parsed: ObliviousTargetsFile;
  try {
    parsed = JSON.parse(raw) as ObliviousTargetsFile;
  } catch (err) {
    console.error("Oblivious-targets registry is not valid JSON:", err);
    process.exit(1);
  }

  if (!Array.isArray(parsed.targets)) {
    console.error("Oblivious-targets registry must have a 'targets' array");
    process.exit(1);
  }

  const seen = new Set<string>();
  for (const target of parsed.targets) {
    if (!target.target_id || typeof target.target_id !== "string") {
      fatal("target_id is required and must be a string", target);
    }
    if (seen.has(target.target_id)) {
      fatal(`Duplicate target_id: ${target.target_id}`, target);
    }
    seen.add(target.target_id);
    if (!target.ohttp_gateway_url || !target.ohttp_gateway_url.startsWith("https://")) {
      fatal(`ohttp_gateway_url must be a valid https:// URL for target_id ${target.target_id}`, target);
    }
  }

  registry = new Map(parsed.targets.map((t) => [t.target_id, t]));
  console.log(`[oblivious-targets] Loaded ${registry.size} oblivious-forwarding target(s)`);
}

function fatal(message: string, target?: Partial<ObliviousTargetConfig>): never {
  const context = target?.target_id ? ` (target_id: ${target.target_id})` : "";
  console.error(`Oblivious-targets registry validation error${context}: ${message}`);
  process.exit(1);
}

export function getObliviousTarget(targetId: string): ObliviousTargetConfig | undefined {
  if (!loadAttempted) throw new Error("Oblivious-targets registry not loaded — call loadObliviousTargets() first");
  return registry?.get(targetId);
}
