import type { AppConfig } from "../apps.js";
import { sendApnsPush } from "./apns.js";
import { sendFcmPush } from "./fcm.js";

export async function dispatchPush(
  pushToken: string,
  uuid: string | null,
  app: AppConfig,
  payload?: Record<string, unknown>
): Promise<void> {
  if (process.env.NODE_ENV === "development") {
    console.log(`[push stub] Would dispatch to ${app.platform} token=${pushToken} uuid=${uuid ?? "null"}`);
    return;
  }

  if (app.platform === "apns") {
    await sendApnsPush(pushToken, uuid, app, payload);
  } else {
    await sendFcmPush(pushToken, uuid, app, payload);
  }
}
