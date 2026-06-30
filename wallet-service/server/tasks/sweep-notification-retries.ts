/**
 * Scheduled retry sweep for notification_jobs (implementation-plan.md
 * §Step 3.3). The inline dispatch attempt in notification-fanout.ts covers
 * the common case; this picks up anything that failed (provider downtime,
 * transient network error) and retries with exponential backoff, up to
 * notification-jobs.ts's MAX_ATTEMPTS before giving up permanently.
 */

import { getPool } from '../db/client.js';
import { findDueJobs, markJobSent, markJobFailed } from '../db/notification-jobs.js';
import { dispatchNotificationJob, type NotificationJobPayload } from '../../src/notifications/dispatch.js';
import { getDispatchDeps } from '../utils/notification-providers.js';

export default defineTask({
  meta: {
    name: 'sweep-notification-retries',
    description: 'Retries failed recovery notification jobs with exponential backoff.',
  },
  async run() {
    const pool = getPool();
    const deps = getDispatchDeps();
    const due = await findDueJobs(pool);

    let sent = 0;
    let failed = 0;

    for (const job of due) {
      try {
        await dispatchNotificationJob(job.channel, job.payload as unknown as NotificationJobPayload, deps);
        await markJobSent(pool, job.id);
        sent++;
      } catch (err) {
        console.warn(`[wallet-service] retry dispatch failed: channel=${job.channel} ${String(err)}`);
        await markJobFailed(pool, job.id, job.attempts);
        failed++;
      }
    }

    return { result: 'done', checked: due.length, sent, failed };
  },
});
