import type { PushoverPayload } from '@mercer/core';
import { NotifyError } from './errors';
import { post } from './http';
import type { DeliveryResult, Notifier } from './notifier';

export interface PushoverConfig {
  appToken: string;
  apiBase: string;
}

export class PushoverNotifier implements Notifier<PushoverPayload> {
  readonly kind = 'pushover' as const;
  readonly capabilities = { updatesInPlace: false, inCardActions: false };

  constructor(
    private readonly cfg: PushoverConfig,
    private readonly timeoutMs?: number,
  ) {}

  async send(userKey: string, payload: PushoverPayload): Promise<DeliveryResult> {
    const form = new URLSearchParams({
      token: this.cfg.appToken,
      user: userKey,
      title: payload.title,
      message: payload.message,
      url: payload.url,
      url_title: payload.url_title,
      priority: String(payload.priority),
    });
    const res = await post(
      'pushover',
      `${this.cfg.apiBase}/1/messages.json`,
      { headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form.toString() },
      this.timeoutMs,
    );
    let body: { status?: number; request?: string; errors?: string[] };
    try {
      body = JSON.parse(res.text) as typeof body;
    } catch {
      throw new NotifyError('Pushover answered with something that is not JSON', 'pushover', true);
    }
    if (body.status !== 1)
      throw new NotifyError(
        `Pushover refused the message: ${(body.errors ?? ['unknown error']).join('; ')}`,
        'pushover',
        false,
      );
    return { providerRef: body.request ?? null, threadRef: null };
  }
}
