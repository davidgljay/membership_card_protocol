import fs from "node:fs";

export interface ApnsConfig {
  key_file: string;
  key_id: string;
  team_id: string;
  bundle_id: string;
  sandbox?: boolean;
}

export interface FcmConfig {
  service_account_file: string;
}

export interface AppConfig {
  app_id: string;
  platform: "apns" | "fcm";
  wallet_ws_url: string;
  apns?: ApnsConfig;
  fcm?: FcmConfig;
}

interface AppRegistryFile {
  apps: AppConfig[];
}

let registry: Map<string, AppConfig> | null = null;

export function loadAppRegistry(path: string): void {
  let raw: string;
  try {
    raw = fs.readFileSync(path, "utf-8");
  } catch (err) {
    console.error(`Failed to read app registry at ${path}:`, err);
    process.exit(1);
  }

  let parsed: AppRegistryFile;
  try {
    parsed = JSON.parse(raw) as AppRegistryFile;
  } catch (err) {
    console.error("App registry is not valid JSON:", err);
    process.exit(1);
  }

  if (!Array.isArray(parsed.apps)) {
    console.error("App registry must have an 'apps' array");
    process.exit(1);
  }

  const seen = new Set<string>();
  for (const app of parsed.apps) {
    validateApp(app, seen);
    seen.add(app.app_id);
  }

  registry = new Map(parsed.apps.map((a) => [a.app_id, a]));
  console.log(`Loaded ${registry.size} app(s) from registry`);
}

function validateApp(app: AppConfig, seen: Set<string>): void {
  if (!app.app_id || typeof app.app_id !== "string") fatal("app_id is required and must be a string", app);
  if (seen.has(app.app_id)) fatal(`Duplicate app_id: ${app.app_id}`, app);
  if (app.platform !== "apns" && app.platform !== "fcm") fatal(`platform must be 'apns' or 'fcm'`, app);
  if (!app.wallet_ws_url || (!app.wallet_ws_url.startsWith("wss://") && !app.wallet_ws_url.startsWith("ws://"))) {
    fatal(`wallet_ws_url must be a valid wss:// URL`, app);
  }

  if (app.platform === "apns") {
    if (app.fcm) fatal("apns app must not have fcm config", app);
    if (!app.apns) fatal("apns platform requires apns config", app);
    const { key_file, key_id, team_id, bundle_id } = app.apns;
    if (!key_file) fatal("apns.key_file is required", app);
    if (!key_id) fatal("apns.key_id is required", app);
    if (!team_id) fatal("apns.team_id is required", app);
    if (!bundle_id) fatal("apns.bundle_id is required", app);
    if (!fs.existsSync(key_file)) fatal(`apns.key_file not found: ${key_file}`, app);
    app.apns.sandbox = app.apns.sandbox ?? true;
  }

  if (app.platform === "fcm") {
    if (app.apns) fatal("fcm app must not have apns config", app);
    if (!app.fcm) fatal("fcm platform requires fcm config", app);
    const { service_account_file } = app.fcm;
    if (!service_account_file) fatal("fcm.service_account_file is required", app);
    if (!fs.existsSync(service_account_file)) {
      fatal(`fcm.service_account_file not found: ${service_account_file}`, app);
    }
  }
}

function fatal(message: string, app?: AppConfig): never {
  const context = app ? ` (app_id: ${app.app_id ?? "unknown"})` : "";
  console.error(`App registry validation error${context}: ${message}`);
  process.exit(1);
}

export function getApp(app_id: string): AppConfig | null {
  if (!registry) throw new Error("App registry not loaded");
  return registry.get(app_id) ?? null;
}

export function getAllApps(): AppConfig[] {
  if (!registry) throw new Error("App registry not loaded");
  return Array.from(registry.values());
}
