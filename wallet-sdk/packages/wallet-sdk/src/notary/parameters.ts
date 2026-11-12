/**
 * Validates job `parameters` against `notary.parameter_bounds` (algorithm W step 6).
 * Field definitions use the card field type system: `integer`, `text`, `boolean`, `cid`, with `required`,
 * `min`, `max`, `regex`, `enum`. Unknown parameters and wrong types are out of bounds.
 */
import type { FieldDefinition } from "@membership-card-protocol/verifier/notary";

export function parametersWithinBounds(parameters: Record<string, unknown>, bounds: FieldDefinition[] | undefined): boolean {
  const defs = bounds ?? [];
  const known = new Set(defs.map((d) => d["name"] as string));
  for (const k of Object.keys(parameters)) if (!known.has(k)) return false;
  for (const d of defs) {
    const name = d["name"] as string;
    const v = parameters[name];
    if (v === undefined) { if (d["required"] === true) return false; continue; }
    switch (d["type"]) {
      case "integer": {
        if (typeof v !== "number" || !Number.isInteger(v)) return false;
        if (typeof d["min"] === "number" && v < d["min"]) return false;
        if (typeof d["max"] === "number" && v > d["max"]) return false;
        break;
      }
      case "boolean": if (typeof v !== "boolean") return false; break;
      case "text": case "cid": {
        if (typeof v !== "string") return false;
        if (typeof d["regex"] === "string" && !new RegExp(d["regex"] as string, "u").test(v)) return false;
        break;
      }
      default: return false;
    }
    if (Array.isArray(d["enum"]) && !(d["enum"] as unknown[]).includes(v)) return false;
  }
  return true;
}
