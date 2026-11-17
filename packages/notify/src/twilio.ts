import type { SmsPayload } from '@mercer/core';
import { NotifyError } from './errors';
import { post } from './http';
import type { DeliveryResult, Notifier } from './notifier';

export interface TwilioConfig {
  accountSid: string;
  authToken: string;
  /** E.164 sender, or a Messaging Service SID (MG…). */
  from: string;
  apiBase: string;
}

export class TwilioNotifier implements Notifier<SmsPayload> {
  readonly kind = 'sms' as const;
  readonly capabilities = { updatesInPlace: false, inCardActions: false };

  constructor(
    private readonly cfg: TwilioConfig,
    private readonly timeoutMs?: number,
  ) {}

  async send(toE164: string, payload: SmsPayload): Promise<DeliveryResult> {
    const form = new URLSearchParams({ To: toE164, Body: payload.body });
    if (this.cfg.from.startsWith('MG')) form.set('MessagingServiceSid', this.cfg.from);
    else form.set('From', this.cfg.from);
    const auth = Buffer.from(`${this.cfg.accountSid}:${this.cfg.authToken}`).toString('base64');
    const res = await post(
      'twilio',
      `${this.cfg.apiBase}/2010-04-01/Accounts/${encodeURIComponent(this.cfg.accountSid)}/Messages.json`,
      {
        headers: {
          authorization: `Basic ${auth}`,
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: form.toString(),
      },
      this.timeoutMs,
    );
    let body: { sid?: string };
    try {
      body = JSON.parse(res.text) as { sid?: string };
    } catch {
      throw new NotifyError('Twilio answered with something that is not JSON', 'twilio', true);
    }
    return { providerRef: body.sid ?? null, threadRef: null };
  }
}
