import Link from 'next/link';
import { budgetState, isSwisConfigured, startOfZonedDay } from '@mercer/core';
import {
  aiSpendSince,
  deviceCounts,
  listChannels,
  listKioskTokens,
  listLocalAccounts,
  listPeople,
  listPollerStates,
  listSites,
} from '@mercer/db';
import { LevelIcon, type Level } from '@/components/status';
import { Card } from '@/components/ui';
import { server } from '@/lib/server';
import { getSettingsState } from '@/lib/settings';

export const dynamic = 'force-dynamic';

interface Item {
  level: Level;
  title: string;
  detail: string;
  href: string;
}

/** The go-live checklist: what is set up, what still uses placeholders, what is optional. */
export default async function SettingsOverview() {
  const state = await getSettingsState();
  const cfg = state.cfg ?? server().bootstrap;
  const db = server().db.db;
  const [pollers, sites, devices, channels, people, locals, kiosks, spent] = await Promise.all([
    listPollerStates(db),
    listSites(db),
    deviceCounts(db),
    listChannels(db),
    listPeople(db),
    listLocalAccounts(db),
    listKioskTokens(db),
    aiSpendSince(db, startOfZonedDay(new Date(), cfg.timezone)),
  ]);
  const alerts = pollers.find((p) => p.poller === 'alerts');
  const fresh =
    !!alerts?.lastSuccessAt &&
    Date.now() - alerts.lastSuccessAt.getTime() < cfg.swis.staleAfterSec * 1000;
  const placeholderSites = sites.filter((s) => s.profileStatus === 'placeholder').length;
  const configured = (k: string) => channels.find((c) => c.key === k)?.configured ?? false;
  const placeholderPeople = people.filter((p) => p.name.includes('(placeholder)')).length;
  const unreachable = people.filter(
    (p) =>
      p.active &&
      ((['sms', 'both'].includes(p.pageVia) && !p.phoneE164) ||
        (['pushover', 'both'].includes(p.pageVia) && !p.pushoverUserKey)),
  ).length;
  const activeLocals = locals.filter((a) => !a.disabledAt).length;
  const activeKiosks = kiosks.filter((k) => !k.revokedAt).length;
  const budget = budgetState(spent, cfg.ai.dailyBudgetUsd);

  const items: Item[] = [
    {
      level: !isSwisConfigured(cfg.swis) ? 'bad' : fresh ? 'ok' : 'bad',
      title: 'SolarWinds connection',
      detail: !isSwisConfigured(cfg.swis)
        ? 'Not set up.'
        : fresh
          ? `Polling ${cfg.swis.baseUrl}.`
          : `No successful alert poll recently${alerts?.lastError ? `: ${alerts.lastError.slice(0, 120)}` : '.'}`,
      href: '/settings/orion',
    },
    {
      level: placeholderSites > 0 ? 'warn' : 'ok',
      title: 'Site profiles',
      detail:
        placeholderSites > 0
          ? `${placeholderSites} of ${sites.length} sites still have placeholder profiles (tier, hours, location).`
          : `${sites.length} sites.`,
      href: '/settings/sites',
    },
    {
      level: devices.unmapped > 0 ? 'warn' : 'ok',
      title: 'Devices mapped to sites',
      detail:
        devices.unmapped > 0
          ? `${devices.unmapped} of ${devices.total} devices have no site.`
          : `All ${devices.total} devices have a site.`,
      href: '/settings/devices',
    },
    {
      level: cfg.auth.entra ? 'ok' : 'unknown',
      title: 'Microsoft sign-in',
      detail: cfg.auth.entra
        ? 'On.'
        : 'Off: only local administrators can sign in. Set it up so the IT team can use the dashboard.',
      href: '/settings/sign-in',
    },
    {
      level: activeLocals >= 2 ? 'ok' : 'unknown',
      title: 'Break-glass accounts',
      detail:
        activeLocals >= 2
          ? `${activeLocals} local administrators.`
          : 'One local administrator. Consider a second, kept somewhere safe.',
      href: '/settings/sign-in',
    },
    {
      level: configured('net-critical') && configured('net-alerts') ? 'ok' : 'warn',
      title: 'Teams channels',
      detail: `${channels.filter((c) => c.configured).length} of ${channels.length} channels have a webhook.`,
      href: '/settings/notifications',
    },
    {
      level: cfg.notify.shadow.enabled ? 'unknown' : 'ok',
      title: 'Shadow mode',
      detail: cfg.notify.shadow.enabled
        ? `On: everything goes to #${cfg.notify.shadow.channelKey} and nobody is paged. Turn it off to go live.`
        : 'Off: notifications are live.',
      href: '/settings/notifications',
    },
    {
      level:
        placeholderPeople > 0 || unreachable > 0
          ? 'warn'
          : cfg.notify.twilio || cfg.notify.pushover
            ? 'ok'
            : 'warn',
      title: 'On-call and paging',
      detail:
        placeholderPeople > 0
          ? `${placeholderPeople} placeholder people are still in the rotation.`
          : unreachable > 0
            ? `${unreachable} active people have no number or Pushover key for how they are paged.`
            : cfg.notify.twilio || cfg.notify.pushover
              ? `${people.filter((p) => p.active).length} people; paging via ${[cfg.notify.twilio && 'SMS', cfg.notify.pushover && 'Pushover'].filter(Boolean).join(' and ')}.`
              : 'Neither Twilio nor Pushover is set up, so nobody can be paged.',
      href: '/settings/oncall',
    },
    {
      level: !cfg.ai.apiKey
        ? 'unknown'
        : !cfg.ai.enabled
          ? 'unknown'
          : budget.level === 'ok'
            ? 'ok'
            : 'warn',
      title: 'AI (Claude)',
      detail: !cfg.ai.apiKey
        ? 'Optional and off: no API key. Summaries and digests use templates.'
        : !cfg.ai.enabled
          ? 'A key is saved but AI is switched off.'
          : `On. US$${budget.spentUsd.toFixed(2)} of US$${budget.budgetUsd.toFixed(2)} spent today.`,
      href: '/settings/ai',
    },
    {
      level: !cfg.digest.enabled ? 'unknown' : configured(cfg.digest.channelKey) ? 'ok' : 'warn',
      title: 'Digests',
      detail: !cfg.digest.enabled
        ? 'Off.'
        : configured(cfg.digest.channelKey)
          ? `Posted to #${cfg.digest.channelKey}.`
          : `#${cfg.digest.channelKey} has no webhook, so digests are only kept in the archive.`,
      href: '/settings/digests',
    },
    {
      level: activeKiosks > 0 ? 'ok' : 'unknown',
      title: 'NOC wall',
      detail:
        activeKiosks > 0
          ? `${activeKiosks} active wall link${activeKiosks === 1 ? '' : 's'}.`
          : 'No wall link yet (optional).',
      href: '/settings/wall',
    },
    {
      level: cfg.worker.deadmanPingUrl ? 'ok' : 'unknown',
      title: 'Dead-man’s switch',
      detail: cfg.worker.deadmanPingUrl
        ? 'MAS pings an external monitor on every heartbeat.'
        : 'Optional: set an external check (e.g. healthchecks.io) that alerts if MAS itself stops.',
      href: '/settings/general',
    },
  ];

  const todo = items.filter((i) => i.level === 'bad' || i.level === 'warn').length;
  return (
    <Card
      title="Overview"
      description={
        todo
          ? `${todo} item${todo > 1 ? 's' : ''} need attention before going live.`
          : 'Everything required is set up.'
      }
    >
      <ul className="divide-y divide-white/10" data-testid="setup-checklist">
        {items.map((i) => (
          <li key={i.title} className="flex items-start gap-3 py-3">
            <span className="mt-0.5">
              <LevelIcon level={i.level === 'unknown' ? 'unknown' : i.level} size={18} />
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium text-slate-100">{i.title}</div>
              <div className="text-sm text-slate-400">{i.detail}</div>
            </div>
            <Link href={i.href} className="shrink-0 text-sm text-sky-300 hover:underline">
              Open
            </Link>
          </li>
        ))}
      </ul>
      <p className="mt-4 text-xs text-slate-500">
        Grey items are optional. Icons: ✓ done, ! needs attention, ✕ broken, ? optional or not set.
      </p>
    </Card>
  );
}
