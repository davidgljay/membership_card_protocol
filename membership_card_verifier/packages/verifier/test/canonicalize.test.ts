import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalize } from "../src/canonicalize.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const conformance = JSON.parse(
  readFileSync(
    join(__dirname, "../../../../specs/serialization-conformance.json"),
    "utf-8"
  )
) as { cases: Array<{ id: string; description: string; input: unknown; expected_json: string }> };

describe("canonicalize — RFC 8785 conformance", () => {
  for (const tc of conformance.cases) {
    it(`${tc.id}: ${tc.description}`, () => {
      const result = canonicalize(tc.input);
      const resultStr = new TextDecoder().decode(result);
      expect(resultStr).toBe(tc.expected_json);
    });
  }
});
