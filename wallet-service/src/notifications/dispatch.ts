/**
 * Notification job dispatch (implementation-plan.md §Step 3.3). Pure
 * function of a job's payload + injected providers — used both for the
 * inline send-on-enqueue attempt (Step 3.2) and the scheduled retry sweep,
 * so the two paths can't drift.
 */

import type { EmailProvider, SmsProvider } from './providers.js';
import {
  emailContent,
  smsContent,
  secondaryContactContent,
  type NotificationContext,
  type NotificationKind,
} from './templates.js';
import type { NotificationChannel } from '../../server/db/notification-jobs.js';

export interface NotificationJobPayload {
  kind: NotificationKind;
  recovery_id: string;
  method: 'synced_passkey' | 'yubikey';
  initiated_at: string;
  cancellation_code: string;
  to?: string; // email address, phone number, or webhook URL depending on channel
  name?: string; // secondary contact display name
}

export interface DispatchDeps {
  emailProvider: EmailProvider;
  smsProvider: SmsProvider;
  /** Injectable for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
}

function toContext(payload: NotificationJobPayload): NotificationContext {
  return {
    recoveryId: payload.recovery_id,
    method: payload.method,
    initiatedAt: new Date(payload.initiated_at),
    cancellationCode: payload.cancellation_code,
  };
}

export async function dispatchNotificationJob(
  channel: NotificationChannel,
  payload: NotificationJobPayload,
  deps: DispatchDeps
): Promise<void> {
  const ctx = toContext(payload);

  switch (channel) {
    case 'email': {
      if (!payload.to) throw new Error('email job missing "to".');
      const { subject, body } = emailContent(payload.kind, ctx);
      await deps.emailProvider.send(payload.to, subject, body);
      return;
    }
    case 'sms': {
      if (!payload.to) throw new Error('sms job missing "to".');
      await deps.smsProvider.send(payload.to, smsContent(payload.kind, ctx));
      return;
    }
    case 'webhook': {
      if (!payload.to) throw new Error('webhook job missing "to" (url).');
      const fetchFn = deps.fetchImpl ?? fetch;
      const res = await fetchFn(payload.to, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          kind: payload.kind,
          recovery_id: payload.recovery_id,
          method: payload.method,
          initiated_at: payload.initiated_at,
        }),
      });
      if (!res.ok) {
        throw new Error(`webhook dispatch failed: HTTP ${res.status}`);
      }
      return;
    }
    case 'secondary_contact_email': {
      if (!payload.to) throw new Error('secondary_contact_email job missing "to".');
      const { subject, body } = secondaryContactContent(payload.kind, payload.name ?? 'Contact', ctx);
      await deps.emailProvider.send(payload.to, subject, body);
      return;
    }
    case 'secondary_contact_sms': {
      if (!payload.to) throw new Error('secondary_contact_sms job missing "to".');
      const { body } = secondaryContactContent(payload.kind, payload.name ?? 'Contact', ctx);
      await deps.smsProvider.send(payload.to, body);
      return;
    }
  }
}
