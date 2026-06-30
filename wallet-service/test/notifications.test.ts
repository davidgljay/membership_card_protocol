import { describe, it, expect, vi } from 'vitest';
import { dispatchNotificationJob, type NotificationJobPayload } from '../src/notifications/dispatch.js';
import type { EmailProvider, SmsProvider } from '../src/notifications/providers.js';

function fakeDeps() {
  const emailProvider: EmailProvider = { send: vi.fn(async () => undefined) };
  const smsProvider: SmsProvider = { send: vi.fn(async () => undefined) };
  const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
  return { emailProvider, smsProvider, fetchImpl };
}

function firstCall(mockFn: ReturnType<typeof vi.fn>): unknown[] {
  const call = mockFn.mock.calls[0];
  if (!call) throw new Error('expected mock to have been called at least once');
  return call;
}

function basePayload(overrides: Partial<NotificationJobPayload> = {}): NotificationJobPayload {
  return {
    kind: 'recovery_initiated',
    recovery_id: 'recovery-1',
    method: 'synced_passkey',
    initiated_at: new Date().toISOString(),
    cancellation_code: 'recovery-1',
    ...overrides,
  };
}

describe('dispatchNotificationJob', () => {
  it('sends an email with cancellation instructions for recovery_initiated', async () => {
    const deps = fakeDeps();
    await dispatchNotificationJob('email', basePayload({ to: 'holder@example.com' }), deps);
    expect(deps.emailProvider.send).toHaveBeenCalledTimes(1);
    const [to, subject, body] = firstCall(deps.emailProvider.send as ReturnType<typeof vi.fn>);
    expect(to).toBe('holder@example.com');
    expect(subject).toMatch(/recovery/i);
    expect(body).toContain('recovery-1');
  });

  it('sends an sms with the cancellation code', async () => {
    const deps = fakeDeps();
    await dispatchNotificationJob('sms', basePayload({ to: '+15551234567' }), deps);
    expect(deps.smsProvider.send).toHaveBeenCalledTimes(1);
    const [to, body] = firstCall(deps.smsProvider.send as ReturnType<typeof vi.fn>);
    expect(to).toBe('+15551234567');
    expect(body).toContain('recovery-1');
  });

  it('posts to the configured webhook URL', async () => {
    const deps = fakeDeps();
    await dispatchNotificationJob('webhook', basePayload({ to: 'https://example.com/hook' }), deps);
    expect(deps.fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = firstCall(deps.fetchImpl as ReturnType<typeof vi.fn>) as [string, RequestInit];
    expect(url).toBe('https://example.com/hook');
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body as string);
    expect(body.recovery_id).toBe('recovery-1');
  });

  it('throws when the webhook responds with a non-2xx status', async () => {
    const deps = fakeDeps();
    deps.fetchImpl = vi.fn(async () => new Response(null, { status: 500 }));
    await expect(
      dispatchNotificationJob('webhook', basePayload({ to: 'https://example.com/hook' }), deps)
    ).rejects.toThrow();
  });

  it('sends a third-party-alert template to the secondary contact, not cancellation instructions', async () => {
    const deps = fakeDeps();
    await dispatchNotificationJob(
      'secondary_contact_email',
      basePayload({ to: 'contact@example.com', name: 'Alex' }),
      deps
    );
    const [to, subject, body] = firstCall(deps.emailProvider.send as ReturnType<typeof vi.fn>);
    expect(to).toBe('contact@example.com');
    expect(subject).not.toMatch(/cancel/i);
    expect(body).toContain('Alex');
    expect(body).not.toContain('recovery-1'); // no cancellation code leaked to a third party
  });

  it('uses a different template for cancellation_confirmed than recovery_initiated', async () => {
    const deps = fakeDeps();
    await dispatchNotificationJob('email', basePayload({ to: 'holder@example.com', kind: 'cancellation_confirmed' }), deps);
    const [, subject, body] = firstCall(deps.emailProvider.send as ReturnType<typeof vi.fn>);
    expect(subject).toMatch(/cancel/i);
    expect(body).not.toContain('recovery-1'); // cancellation confirmations don't carry a cancellation code
  });

  it('throws for a channel missing its recipient', async () => {
    const deps = fakeDeps();
    await expect(dispatchNotificationJob('email', basePayload(), deps)).rejects.toThrow();
  });
});
