import apn from "node-apn";
import type { AppConfig } from "../apps.js";

// Provider instances cached by app_id
const providers = new Map<string, apn.Provider>();

function getProvider(app: AppConfig): apn.Provider {
  const existing = providers.get(app.app_id);
  if (existing) return existing;

  if (!app.apns) throw new Error(`Missing APNs config for app ${app.app_id}`);

  const provider = new apn.Provider({
    token: {
      key: app.apns.key_file,
      keyId: app.apns.key_id,
      teamId: app.apns.team_id,
    },
    production: !(app.apns.sandbox ?? true),
  });

  providers.set(app.app_id, provider);
  return provider;
}

export async function sendApnsPush(
  pushToken: string,
  uuid: string | null,
  app: AppConfig,
  payload?: Record<string, unknown>
): Promise<void> {
  const provider = getProvider(app);

  const note = new apn.Notification();
  note.contentAvailable = true;
  note.topic = app.apns!.bundle_id;
  note.payload = payload ?? { uuid };
  note.pushType = "background";

  const result = await provider.send(note, pushToken);

  if (result.failed.length > 0) {
    const failure = result.failed[0];
    const reason = failure.response?.reason ?? failure.error?.message ?? "unknown";
    throw new Error(`APNs delivery failed: ${reason}`);
  }
}

export function shutdownApnsProviders(): void {
  for (const provider of providers.values()) {
    provider.shutdown();
  }
  providers.clear();
}
