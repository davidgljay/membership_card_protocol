#!/usr/bin/env -S npx tsx
/**
 * Renders `matrix/homeserver.yaml` from `matrix/homeserver.yaml.template`,
 * and `matrix/appservice-registration.yaml` from
 * `matrix/appservice-registration.yaml.template` (Step 14).
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
 * ---------------------------------------------------------------------
 * appservice-registration.yaml.template's two extra variables (Step 14)
 * ---------------------------------------------------------------------
 * `matrix/appservice-registration.yaml.template` needs two values that
 * aren't ordinary `.env` config:
 *
 *   - ${MATRIX_AS_TOKEN} / ${MATRIX_HS_TOKEN}: read from the bare secret
 *     files scripts/generate-matrix-secrets.ts writes (Step 14) —
 *     matrix/secrets/appservice-as-token.txt and appservice-hs-token.txt —
 *     rather than from the environment, since these are generated secrets,
 *     not deployment config. generate-matrix-secrets.ts must be run first.
 *   - ${MATRIX_SERVER_NAME_REGEX}: not read from anywhere — it's derived
 *     here from ${MATRIX_SERVER_NAME} by escaping regex metacharacters
 *     (the AS's user-namespace regex embeds the server name after a
 *     literal `:`, and a bare domain like "matrix.internal" contains an
 *     unescaped `.` that would otherwise match any character).
 *
 * Usage: npx tsx scripts/render-matrix-config.ts
 * Run this (and scripts/generate-matrix-secrets.ts, which must run first
 * so the AS token files above exist) before `docker compose up synapse`.
 * Re-run after any change to matrix/homeserver.yaml.template,
 * matrix/appservice-registration.yaml.template, or the env vars/secret
 * files they reference.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const MATRIX_DIR = path.join(SCRIPT_DIR, '..', 'matrix');
const SECRETS_DIR = path.join(MATRIX_DIR, 'secrets');

const HOMESERVER_TEMPLATE_PATH = path.join(MATRIX_DIR, 'homeserver.yaml.template');
const HOMESERVER_OUTPUT_PATH = path.join(MATRIX_DIR, 'homeserver.yaml');

const APPSERVICE_TEMPLATE_PATH = path.join(MATRIX_DIR, 'appservice-registration.yaml.template');
const APPSERVICE_OUTPUT_PATH = path.join(MATRIX_DIR, 'appservice-registration.yaml');

const AS_TOKEN_PATH = path.join(SECRETS_DIR, 'appservice-as-token.txt');
const HS_TOKEN_PATH = path.join(SECRETS_DIR, 'appservice-hs-token.txt');

const VAR_PATTERN = /\$\{([A-Z0-9_]+)\}/g;

/** Escapes regex metacharacters so a literal domain name is safe to embed in a regex. */
function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function readSecretFile(filePath: string): string {
  try {
    return readFileSync(filePath, 'utf8').trim();
  } catch (err) {
    console.error(
      `render-matrix-config: could not read ${filePath} — run scripts/generate-matrix-secrets.ts first.`
    );
    throw err;
  }
}

function requireVar(name: string, vars: Record<string, string | undefined>): string {
  const val = vars[name];
  if (val === undefined || val === '') {
    console.error(`render-matrix-config: required variable ${name} is missing or empty.`);
    process.exit(1);
  }
  return val;
}

function render(template: string, vars: Record<string, string | undefined>): string {
  const missing = new Set<string>();
  const rendered = template.replace(VAR_PATTERN, (_match, varName: string) => {
    const val = vars[varName];
    if (val === undefined || val === '') {
      missing.add(varName);
      return `\${${varName}}`; // leave as-is so the error list below is complete, not just the first miss
    }
    return val;
  });

  if (missing.size > 0) {
    for (const name of missing) {
      requireVar(name, vars); // reuses the same fail-fast message/exit-code convention as src/config.ts
    }
  }

  return rendered;
}

function main(): void {
  // --- homeserver.yaml: plain env-var substitution ---
  const homeserverTemplate = readFileSync(HOMESERVER_TEMPLATE_PATH, 'utf8');
  const homeserverRendered = render(homeserverTemplate, process.env);
  writeFileSync(HOMESERVER_OUTPUT_PATH, homeserverRendered, { mode: 0o644 });
  console.log(`Rendered ${HOMESERVER_TEMPLATE_PATH} -> ${HOMESERVER_OUTPUT_PATH}`);

  // --- appservice-registration.yaml: env vars + generated secret files ---
  const serverName = requireVar('MATRIX_SERVER_NAME', process.env);
  const appserviceVars: Record<string, string | undefined> = {
    ...process.env,
    MATRIX_AS_TOKEN: readSecretFile(AS_TOKEN_PATH),
    MATRIX_HS_TOKEN: readSecretFile(HS_TOKEN_PATH),
    MATRIX_SERVER_NAME_REGEX: escapeRegex(serverName),
  };
  const appserviceTemplate = readFileSync(APPSERVICE_TEMPLATE_PATH, 'utf8');
  const appserviceRendered = render(appserviceTemplate, appserviceVars);
  writeFileSync(APPSERVICE_OUTPUT_PATH, appserviceRendered, { mode: 0o644 });
  console.log(`Rendered ${APPSERVICE_TEMPLATE_PATH} -> ${APPSERVICE_OUTPUT_PATH}`);
}

main();
