#!/usr/bin/env -S npx tsx
/**
 * Renders `matrix/homeserver.yaml` from `matrix/homeserver.yaml.template`.
 *
 * ---------------------------------------------------------------------
 * Why this script exists: Synapse has no native `${VAR}` substitution.
 * ---------------------------------------------------------------------
 * `specs/object_specs/matrix_synapse_module.md` originally claimed "Synapse
 * substitutes `${VAR}` from the process environment when parsing
 * `homeserver.yaml` (standard Synapse config templating)." That claim is
 * wrong — confirmed by checking Synapse's own docs/issue tracker (e.g.
 * matrix-org/synapse#11489, #7758): general `${VAR}`-style substitution in
 * arbitrary config keys has been a long-standing, unimplemented feature
 * request, not a shipped capability. The only env-var templating Synapse's
 * docker image does natively is a narrow, fixed set of values (server_name,
 * report_stats, etc.) applied during its own `--generate-config` first-run
 * flow — which we don't use, since we supply our own custom `modules:`
 * block that flow knows nothing about.
 *
 * So a `homeserver.yaml` containing literal `"${MATRIX_SERVER_NAME}"` etc.
 * would load into Synapse as that literal string, not the real value. This
 * script closes that gap the same way `scripts/generate-matrix-secrets.ts`
 * closes the analogous gap for credentials: render the real, concrete file
 * from a git-tracked template, once, before `docker compose up`, rather
 * than expecting either Synapse or Docker Compose to do it (Compose's own
 * `${VAR}` substitution only applies to docker-compose.yml's own content —
 * it has no visibility into the contents of a file it bind-mounts).
 *
 * Usage: npx tsx scripts/render-matrix-config.ts
 * Run this (and scripts/generate-matrix-secrets.ts) before `docker compose
 * up synapse`. Re-run after any change to matrix/homeserver.yaml.template
 * or to the env vars it references.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const MATRIX_DIR = path.join(SCRIPT_DIR, '..', 'matrix');
const TEMPLATE_PATH = path.join(MATRIX_DIR, 'homeserver.yaml.template');
const OUTPUT_PATH = path.join(MATRIX_DIR, 'homeserver.yaml');

const VAR_PATTERN = /\$\{([A-Z0-9_]+)\}/g;

function requireEnv(name: string): string {
  const val = process.env[name];
  if (val === undefined || val === '') {
    console.error(`render-matrix-config: required environment variable ${name} is missing or empty.`);
    process.exit(1);
  }
  return val;
}

function render(template: string): string {
  const missing = new Set<string>();
  const rendered = template.replace(VAR_PATTERN, (_match, varName: string) => {
    const val = process.env[varName];
    if (val === undefined || val === '') {
      missing.add(varName);
      return `\${${varName}}`; // leave as-is so the error list below is complete, not just the first miss
    }
    return val;
  });

  if (missing.size > 0) {
    for (const name of missing) {
      requireEnv(name); // reuses the same fail-fast message/exit-code convention as src/config.ts
    }
  }

  return rendered;
}

function main(): void {
  const template = readFileSync(TEMPLATE_PATH, 'utf8');
  const rendered = render(template);
  writeFileSync(OUTPUT_PATH, rendered, { mode: 0o644 });
  console.log(`Rendered ${TEMPLATE_PATH} -> ${OUTPUT_PATH}`);
}

main();
