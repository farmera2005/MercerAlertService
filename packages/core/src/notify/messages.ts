/**
 * What notifications say. Teams gets an Adaptive Card posted through a Teams Workflows webhook
 * (the retired Office 365 connectors are not used); its buttons open the dashboard
 * (Action.OpenUrl), never act directly, so a link preview or a forwarded card cannot ack
 * anything. SMS stays under 300 characters with a short link; Pushover gets a title and URL.
 */
import { formatDuration } from '../dashboard/text';
import type { NotifyIncident } from './types';

export const SMS_MAX = 300;

export interface MessageLinks {
  view: string;
  ack: string;
  snooze: string;
  /** Short link for SMS/push (/i/<code>). */
  short: string;
}

export type CardKind = 'open' | 'update' | 'resolved' | 'escalation';

export interface TeamsPayload {
  type: 'message';
  attachments: Array<{
    contentType: 'application/vnd.microsoft.card.adaptive';
    contentUrl: null;
    content: AdaptiveCard;
  }>;
}

export interface AdaptiveCard {
  $schema: string;
  type: 'AdaptiveCard';
  version: '1.4';
  msteams: { width: 'Full' };
  body: unknown[];
  actions?: unknown[];
}

export interface SmsPayload {
  body: string;
}

export interface PushoverPayload {
  title: string;
  message: string;
  url: string;
  url_title: string;
  /** -1 quiet, 0 normal, 1 high (bypasses the user's quiet hours). */
  priority: -1 | 0 | 1;
}

const STYLE: Record<string, 'attention' | 'warning' | 'accent' | 'default'> = {
  P1: 'attention',
  P2: 'warning',
  P3: 'accent',
  P4: 'default',
};

const KIND_LABEL: Record<string, string> = {
  site_outage: 'Site outage',
  device_down: 'Device down',
  flapping: 'Flapping',
  interface: 'Interface',
  ups_power: 'UPS / power',
  service: 'Service',
  monitoring_source_down: 'Monitoring down',
  generic: 'Alert',
};

function wrapCard(body: unknown[], actions: unknown[]): TeamsPayload {
  return {
    type: 'message',
    attachments: [
      {
        contentType: 'application/vnd.microsoft.card.adaptive',
        contentUrl: null,
        content: {
          $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
          type: 'AdaptiveCard',
          version: '1.4',
          msteams: { width: 'Full' },
          body,
          ...(actions.length ? { actions } : {}),
        },
      },
    ],
  };
}

const text = (t: string, extra: Record<string, unknown> = {}) => ({
  type: 'TextBlock',
  text: t,
  wrap: true,
  ...extra,
});

function statusText(i: NotifyIncident): string {
  if (i.status === 'acknowledged') return `Acknowledged by ${i.acknowledgedBy ?? 'someone'}`;
  if (i.status === 'resolved' || i.status === 'closed')
    return i.resolvedBy?.startsWith('user:')
      ? `Resolved by ${i.resolvedBy.slice(5)}`
      : 'Resolved (all alerts cleared)';
  return 'Open, not acknowledged';
}

export interface CardOptions {
  kind: CardKind;
  links: MessageLinks;
  now: Date;
  /** "Update 2: Priority P3 → P1" */
  change?: string;
  updateNo?: number;
  /** Shadow mode: where this would really have gone, and who would have been paged. */
  shadow?: { intendedChannels: string[]; wouldPage: string[] };
}

export function teamsCard(i: NotifyIncident, o: CardOptions): TeamsPayload {
  const ref = `INC-${i.id}`;
  const body: unknown[] = [];
  if (o.shadow) {
    const where = o.shadow.intendedChannels.length
      ? `for ${o.shadow.intendedChannels.map((c) => `#${c}`).join(', ')}`
      : 'no channel would be posted';
    body.push(
      text(
        `**[SHADOW]** ${where}${o.shadow.wouldPage.length ? ` · would page ${o.shadow.wouldPage.join(', ')}` : ''}`,
        { color: 'warning', size: 'Small' },
      ),
    );
  }
  const head =
    o.kind === 'resolved'
      ? `RESOLVED · ${i.priority} · ${KIND_LABEL[i.kind] ?? i.kind}`
      : o.kind === 'escalation'
        ? `ESCALATED · ${i.priority} · ${KIND_LABEL[i.kind] ?? i.kind}`
        : o.kind === 'update'
          ? `${ref} · Update ${o.updateNo ?? 1}${o.change ? `: ${o.change}` : ''}`
          : `${i.priority} · ${KIND_LABEL[i.kind] ?? i.kind}`;
  body.push({
    type: 'Container',
    style: o.kind === 'resolved' ? 'good' : (STYLE[i.priority] ?? 'default'),
    bleed: true,
    items: [
      text(head, { weight: 'Bolder', size: 'Small' }),
      text(i.title, { weight: 'Bolder', size: 'Large' }),
    ],
  });
  if (o.kind === 'escalation' && o.change) body.push(text(o.change, { color: 'attention' }));
  body.push(text(i.summary));
  if (i.ai && o.kind !== 'resolved') {
    body.push({
      type: 'Container',
      style: 'emphasis',
      items: [
        text('Summary (AI)', { weight: 'Bolder', size: 'Small', isSubtle: true }),
        text(`**Affected:** ${i.ai.whatIsAffected}`),
        text(`**Likely cause** (${i.ai.confidence} confidence): ${i.ai.likelyCause}`),
        text(`**First steps**\n${i.ai.firstSteps.map((s, n) => `${n + 1}. ${s}`).join('\n')}`),
      ],
    });
  }
  const end = i.resolvedAt ?? o.now;
  body.push({
    type: 'FactSet',
    facts: [
      { title: 'Site', value: i.siteName ?? '—' },
      { title: 'Division', value: i.divisionName ?? '—' },
      { title: 'Alerts', value: String(i.alertCount) },
      {
        title: o.kind === 'resolved' ? 'Duration' : 'Open for',
        value: formatDuration(end.getTime() - i.openedAt.getTime()),
      },
      { title: 'Status', value: statusText(i) },
      { title: 'Incident', value: ref },
    ],
  });
  const actions: unknown[] = [{ type: 'Action.OpenUrl', title: 'View', url: o.links.view }];
  if (i.status === 'open')
    actions.push({ type: 'Action.OpenUrl', title: 'Acknowledge', url: o.links.ack });
  if (i.status === 'open' || i.status === 'acknowledged')
    actions.push({ type: 'Action.OpenUrl', title: 'Snooze', url: o.links.snooze });
  return wrapCard(body, actions);
}

/** A plain card for test-sends and MAS's own alerts about itself. */
export function teamsNotice(title: string, detail: string, url?: string): TeamsPayload {
  return wrapCard(
    [
      {
        type: 'Container',
        style: 'emphasis',
        bleed: true,
        items: [text(title, { weight: 'Bolder', size: 'Medium' })],
      },
      text(detail),
    ],
    url ? [{ type: 'Action.OpenUrl', title: 'Open MAS', url }] : [],
  );
}

function fit(prefix: string, title: string, suffix: string): string {
  const room = SMS_MAX - prefix.length - suffix.length;
  const t = title.length > room ? `${title.slice(0, Math.max(0, room - 1))}…` : title;
  return `${prefix}${t}${suffix}`;
}

export function smsText(
  i: NotifyIncident,
  o: { kind: 'page' | 'escalation' | 'resolved'; link: string; now: Date; escalatedFrom?: string },
): string {
  const where = i.siteName && !i.title.includes(i.siteName) ? ` (${i.siteName})` : '';
  if (o.kind === 'resolved') {
    const took = formatDuration((i.resolvedAt ?? o.now).getTime() - i.openedAt.getTime());
    return fit(
      `RESOLVED ${i.priority} `,
      `${i.title}${where}`,
      ` after ${took}. INC-${i.id} [MAS]`,
    );
  }
  const prefix =
    o.kind === 'escalation'
      ? `ESCALATED${o.escalatedFrom ? ` (no ack from ${o.escalatedFrom})` : ''} ${i.priority} `
      : `${i.priority} `;
  const alerts = i.alertCount > 1 ? ` ${i.alertCount} alerts.` : '';
  return fit(prefix, `${i.title}${where}`, `.${alerts} Ack: ${o.link} [MAS]`);
}

export function pushoverPayload(
  i: NotifyIncident,
  o: { kind: 'page' | 'escalation' | 'resolved'; link: string; now: Date; escalatedFrom?: string },
): PushoverPayload {
  const label = o.kind === 'resolved' ? 'RESOLVED ' : o.kind === 'escalation' ? 'ESCALATED ' : '';
  const message =
    o.kind === 'resolved'
      ? `Resolved after ${formatDuration((i.resolvedAt ?? o.now).getTime() - i.openedAt.getTime())}.`
      : `${o.kind === 'escalation' && o.escalatedFrom ? `Not acknowledged by ${o.escalatedFrom}. ` : ''}${i.summary}`;
  return {
    title: `${label}${i.priority} · ${i.title}`.slice(0, 250),
    message: message.slice(0, 1024),
    url: o.link,
    url_title: o.kind === 'resolved' ? 'Open incident' : 'Acknowledge',
    priority: o.kind === 'resolved' ? 0 : 1,
  };
}
