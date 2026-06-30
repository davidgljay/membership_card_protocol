/**
 * Recovery notification fan-out (implementation-plan.md §Step 3.2, §Step
 * 3.3). Enqueues a durable job per configured channel, then makes one
 * immediate inline dispatch attempt per job — this is what gets all
 * channels notified within the spec's window in the common case, without
 * waiting on the retry sweep. Failed inline attempts are left `pending`
 * for the scheduled sweep to retry with backoff.
 */

import type { Pool } from 'pg';
import type { BackupRegistrationRow } from '../db/backups.js';
import type { RecoveryWindowRow } from '../db/recovery.js';
import { enqueueNotificationJob, markJobSent, markJobFailed } from '../db/notification-jobs.js';
import type { NotificationChannel, NotificationJobRow } from '../db/notification-jobs.js';
import { dispatchNotificationJob, type NotificationJobPayload } from '../../src/notifications/dispatch.js';
import type { NotificationKind } from '../../src/notifications/templates.js';
import { getDispatchDeps } from './notification-providers.js';

interface PlannedJob {
  channel: NotificationChannel;
  payload: NotificationJobPayload;
}

function planJobs(
  recovery: RecoveryWindowRow,
  backup: BackupRegistrationRow,
  kind: NotificationKind
): PlannedJob[] {
  const base = {
    kind,
    recovery_id: recovery.id,
    method: backup.type,
    initiated_at: recovery.initiated_at.toISOString(),
    cancellation_code: recovery.id,
  };
  const channels = backup.notification_channels;
  const jobs: PlannedJob[] = [];

  if (channels.email) {
    jobs.push({ channel: 'email', payload: { ...base, to: channels.email } });
  }
  if (channels.sms) {
    jobs.push({ channel: 'sms', payload: { ...base, to: channels.sms } });
  }
  if (channels.webhook) {
    jobs.push({ channel: 'webhook', payload: { ...base, to: channels.webhook } });
  }
  if (channels.secondary_contact?.email) {
    jobs.push({
      channel: 'secondary_contact_email',
      payload: { ...base, to: channels.secondary_contact.email, name: channels.secondary_contact.name },
    });
  }
  if (channels.secondary_contact?.sms) {
    jobs.push({
      channel: 'secondary_contact_sms',
      payload: { ...base, to: channels.secondary_contact.sms, name: channels.secondary_contact.name },
    });
  }
  return jobs;
}

/** Enqueues + makes one inline dispatch attempt per configured channel. Returns the list of channels enqueued (implementation-plan.md §Step 3.2 `notified_channels`). */
export async function fanOutRecoveryNotifications(
  pool: Pool,
  recovery: RecoveryWindowRow,
  backup: BackupRegistrationRow,
  kind: NotificationKind
): Promise<NotificationChannel[]> {
  const planned = planJobs(recovery, backup, kind);
  const deps = getDispatchDeps();

  const rows: NotificationJobRow[] = await Promise.all(
    planned.map((job) => enqueueNotificationJob(pool, recovery.id, job.channel, job.payload))
  );

  await Promise.all(
    rows.map(async (row) => {
      try {
        await dispatchNotificationJob(row.channel, row.payload as unknown as NotificationJobPayload, deps);
        await markJobSent(pool, row.id);
      } catch (err) {
        console.warn(`[wallet-service] notification dispatch failed, will retry: channel=${row.channel} ${String(err)}`);
        await markJobFailed(pool, row.id, row.attempts);
      }
    })
  );

  return planned.map((job) => job.channel);
}
