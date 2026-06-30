/**
 * Notification provider interfaces (implementation-plan.md §Step 3.3).
 * Pluggable per channel, mirroring the SecretsBackend pattern from Phase 1:
 * a real default implementation, selected by config, with dependency
 * injection at the call site for testing.
 */

export interface EmailProvider {
  send(to: string, subject: string, body: string): Promise<void>;
}

export interface SmsProvider {
  send(to: string, body: string): Promise<void>;
}

/** SendGrid v3 Mail Send API (https://docs.sendgrid.com/api-reference/mail-send/mail-send). Default email provider. */
export class SendGridEmailProvider implements EmailProvider {
  constructor(
    private readonly apiKey: string,
    private readonly fromEmail: string
  ) {}

  async send(to: string, subject: string, body: string): Promise<void> {
    const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: to }] }],
        from: { email: this.fromEmail },
        subject,
        content: [{ type: 'text/plain', value: body }],
      }),
    });
    if (!res.ok) {
      throw new Error(`SendGrid send failed: HTTP ${res.status}`);
    }
  }
}

/** Twilio Programmable Messaging API. Default SMS provider. */
export class TwilioSmsProvider implements SmsProvider {
  constructor(
    private readonly accountSid: string,
    private readonly authToken: string,
    private readonly fromNumber: string
  ) {}

  async send(to: string, body: string): Promise<void> {
    const auth = Buffer.from(`${this.accountSid}:${this.authToken}`).toString('base64');
    const res = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${this.accountSid}/Messages.json`,
      {
        method: 'POST',
        headers: {
          Authorization: `Basic ${auth}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ To: to, From: this.fromNumber, Body: body }).toString(),
      }
    );
    if (!res.ok) {
      throw new Error(`Twilio send failed: HTTP ${res.status}`);
    }
  }
}

/**
 * Dev/test fallback when no provider credentials are configured. Logs
 * only — never silently "succeeds" the security-relevant 72-hour
 * notification guarantee in a real deployment, but lets the wallet
 * service run locally without external accounts.
 */
export class ConsoleEmailProvider implements EmailProvider {
  async send(to: string, subject: string, body: string): Promise<void> {
    console.info(`[notifications] (console fallback) email to=${to} subject=${JSON.stringify(subject)}`);
    void body;
  }
}

export class ConsoleSmsProvider implements SmsProvider {
  async send(to: string): Promise<void> {
    console.info(`[notifications] (console fallback) sms to=${to}`);
  }
}
