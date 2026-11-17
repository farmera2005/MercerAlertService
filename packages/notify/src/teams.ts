import type { TeamsPayload } from '@mercer/core';
import { NotifyError } from './errors';
import { post } from './http';
import type { DeliveryResult, Notifier } from './notifier';

/** Teams Workflows ("When a Teams webhook request is received" → post card to a channel). */
export class TeamsWorkflowsNotifier implements Notifier<TeamsPayload> {
  readonly kind = 'teams' as const;
  readonly capabilities = { updatesInPlace: false, inCardActions: false };

  constructor(private readonly opts: { allowHttp?: boolean; timeoutMs?: number } = {}) {}

  async send(webhookUrl: string, payload: TeamsPayload): Promise<DeliveryResult> {
    assertWebhookUrl(webhookUrl, this.opts.allowHttp ?? false);
    const res = await post(
      'teams',
      webhookUrl,
      { headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) },
      this.opts.timeoutMs,
    );
    return { providerRef: res.headers.get('x-ms-workflow-run-id'), threadRef: null };
  }
}

export function assertWebhookUrl(url: string, allowHttp: boolean): void {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new NotifyError('the Teams webhook URL is not a valid URL', 'teams', false);
  }
  if (u.protocol !== 'https:' && !(allowHttp && u.protocol === 'http:'))
    throw new NotifyError('the Teams webhook URL must use https://', 'teams', false);
}
