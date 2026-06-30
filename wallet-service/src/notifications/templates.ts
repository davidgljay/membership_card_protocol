/**
 * Notification content templates (implementation-plan.md §Step 3.3,
 * §wallet_backup_and_recovery.md Process 2a/2b Step 2-3). Two distinct
 * templates per the spec: cancellation-instruction templates for the
 * holder's own channels, and a third-party-alert template for the
 * secondary contact — who should never receive cancellation instructions
 * for an account that isn't theirs.
 */

export type NotificationKind = 'recovery_initiated' | 'cancellation_confirmed';

export interface NotificationContext {
  recoveryId: string;
  method: 'synced_passkey' | 'yubikey';
  initiatedAt: Date;
  cancellationCode: string; // recovery_id, base64url — same value used as the cancel challenge (Step 3.4)
}

export function emailContent(kind: NotificationKind, ctx: NotificationContext): { subject: string; body: string } {
  const methodLabel = ctx.method === 'synced_passkey' ? 'synced passkey' : 'YubiKey';
  if (kind === 'recovery_initiated') {
    return {
      subject: 'Wallet recovery initiated — action required if this was not you',
      body: [
        `A wallet recovery was initiated at ${ctx.initiatedAt.toISOString()} using your ${methodLabel}.`,
        `If you did not initiate this, cancel it within 72 hours using this code: ${ctx.cancellationCode}`,
        `If you do not cancel, your wallet will be released for recovery after the 72-hour window.`,
      ].join('\n'),
    };
  }
  return {
    subject: 'Wallet recovery cancelled',
    body: [
      `The wallet recovery initiated at ${ctx.initiatedAt.toISOString()} has been cancelled.`,
      `If you did not request this cancellation, your account credentials may be compromised.`,
    ].join('\n'),
  };
}

export function smsContent(kind: NotificationKind, ctx: NotificationContext): string {
  if (kind === 'recovery_initiated') {
    return `Wallet recovery started via ${ctx.method}. Not you? Cancel within 72h: ${ctx.cancellationCode}`;
  }
  return `Wallet recovery cancelled. If this wasn't you, your account may be compromised.`;
}

export function webhookPayload(kind: NotificationKind, ctx: NotificationContext): Record<string, unknown> {
  return {
    kind,
    recovery_id: ctx.recoveryId,
    method: ctx.method,
    initiated_at: ctx.initiatedAt.toISOString(),
  };
}

/** Third-party alert — informational only, no cancellation instructions (this isn't the secondary contact's account). */
export function secondaryContactContent(
  kind: NotificationKind,
  contactName: string,
  ctx: NotificationContext
): { subject: string; body: string } {
  const methodLabel = ctx.method === 'synced_passkey' ? 'synced passkey' : 'YubiKey';
  if (kind === 'recovery_initiated') {
    return {
      subject: 'Wallet recovery alert',
      body: `${contactName}, you're registered as a secondary contact. A wallet recovery using ${methodLabel} was initiated at ${ctx.initiatedAt.toISOString()}. No action is required from you.`,
    };
  }
  return {
    subject: 'Wallet recovery cancelled',
    body: `${contactName}, the wallet recovery initiated at ${ctx.initiatedAt.toISOString()} has been cancelled.`,
  };
}
