#!/usr/bin/env node
// Materializes the app registry, oblivious-targets registry, and per-app
// push credential files from env vars, for platforms with no
// persistent/mountable volume (DigitalOcean App Platform) or where baking
// a plain-JSON registry into the image isn't wanted (the Droplet path --
// see relay/DEPLOYMENT.md's "Required environment variables"). No-op per
// registry if its *_JSON var isn't set -- docker-compose's bind-mounted
// ./config/apps.json (local dev) is used unchanged in that case, since
// server.ts / utils/apps.ts / utils/oblivious_targets.ts only ever read
// files off disk, never env vars directly.
import fs from 'node:fs';
import path from 'node:path';

const targetsJson = process.env.OBLIVIOUS_TARGETS_JSON;
if (targetsJson) {
  const targetsPath = process.env.OBLIVIOUS_TARGETS_PATH ?? '/app/config/oblivious_targets.json';
  fs.mkdirSync(path.dirname(targetsPath), { recursive: true });
  fs.writeFileSync(targetsPath, targetsJson);
  const parsedTargets = JSON.parse(targetsJson);
  console.log(`Materialized oblivious-targets registry (${parsedTargets.targets?.length ?? 0} target(s)) from env var.`);
}

const registryJson = process.env.APP_REGISTRY_JSON;
if (!registryJson) {
  process.exit(0);
}

const registryPath = process.env.APP_REGISTRY_PATH ?? '/app/config/apps.json';
fs.mkdirSync(path.dirname(registryPath), { recursive: true });
fs.writeFileSync(registryPath, registryJson);

const parsed = JSON.parse(registryJson);

// Per-app credential file env var naming: <PLATFORM_KEY>_<APP_ID_AS_ENV_NAME>_B64,
// base64-encoded file content, decoded to the key_file/service_account_file
// path that app's entry in the registry declares. Per-app because platform
// credentials are dynamically-named/one-per-app_id -- see relay-deploy.yml's
// validate-secrets comment on why these can't be enumerated ahead of time.
for (const app of parsed.apps ?? []) {
  const envKey = app.app_id.toUpperCase().replace(/[^A-Z0-9]/g, '_');

  if (app.platform === 'apns' && app.apns?.key_file) {
    const b64 = process.env[`APNS_KEY_${envKey}_B64`];
    if (!b64) {
      console.error(`Missing APNS_KEY_${envKey}_B64 for app '${app.app_id}' (platform apns)`);
      process.exit(1);
    }
    fs.mkdirSync(path.dirname(app.apns.key_file), { recursive: true });
    fs.writeFileSync(app.apns.key_file, Buffer.from(b64, 'base64'));
  }

  if (app.platform === 'fcm' && app.fcm?.service_account_file) {
    const b64 = process.env[`FCM_SERVICE_ACCOUNT_${envKey}_B64`];
    if (!b64) {
      console.error(`Missing FCM_SERVICE_ACCOUNT_${envKey}_B64 for app '${app.app_id}' (platform fcm)`);
      process.exit(1);
    }
    fs.mkdirSync(path.dirname(app.fcm.service_account_file), { recursive: true });
    fs.writeFileSync(app.fcm.service_account_file, Buffer.from(b64, 'base64'));
  }
}

console.log(`Materialized app registry (${parsed.apps?.length ?? 0} app(s)) and credential file(s) from env vars.`);
