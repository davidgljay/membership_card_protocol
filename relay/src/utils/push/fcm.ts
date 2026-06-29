import admin from "firebase-admin";
import type { AppConfig } from "../apps.js";

// App instances cached by app_id
const apps = new Map<string, admin.app.App>();

function getApp(app: AppConfig): admin.app.App {
  const existing = apps.get(app.app_id);
  if (existing) return existing;

  if (!app.fcm) throw new Error(`Missing FCM config for app ${app.app_id}`);

  const firebaseApp = admin.initializeApp(
    {
      credential: admin.credential.cert(app.fcm.service_account_file),
    },
    app.app_id
  );

  apps.set(app.app_id, firebaseApp);
  return firebaseApp;
}

export async function sendFcmPush(
  pushToken: string,
  uuid: string | null,
  app: AppConfig,
  payload?: Record<string, unknown>
): Promise<void> {
  const firebaseApp = getApp(app);

  const data: Record<string, string> = {};
  const source = payload ?? { uuid };
  for (const [k, v] of Object.entries(source)) {
    data[k] = String(v ?? "");
  }

  await firebaseApp.messaging().send({
    token: pushToken,
    data,
    android: {
      priority: "high",
    },
  });
}
