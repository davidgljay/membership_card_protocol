import { loadConfig } from '../../src/config.js';
import {
  SendGridEmailProvider,
  TwilioSmsProvider,
  ConsoleEmailProvider,
  ConsoleSmsProvider,
  type EmailProvider,
  type SmsProvider,
} from '../../src/notifications/providers.js';
import type { DispatchDeps } from '../../src/notifications/dispatch.js';

let cached: DispatchDeps | null = null;

export function getDispatchDeps(): DispatchDeps {
  if (cached) return cached;

  const config = loadConfig();

  const emailProvider: EmailProvider =
    config.SENDGRID_API_KEY && config.SENDGRID_FROM_EMAIL
      ? new SendGridEmailProvider(config.SENDGRID_API_KEY, config.SENDGRID_FROM_EMAIL)
      : new ConsoleEmailProvider();

  const smsProvider: SmsProvider =
    config.TWILIO_ACCOUNT_SID && config.TWILIO_AUTH_TOKEN && config.TWILIO_FROM_NUMBER
      ? new TwilioSmsProvider(config.TWILIO_ACCOUNT_SID, config.TWILIO_AUTH_TOKEN, config.TWILIO_FROM_NUMBER)
      : new ConsoleSmsProvider();

  cached = { emailProvider, smsProvider };
  return cached;
}
