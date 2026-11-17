import Link from 'next/link';
import {
  INCIDENT_KINDS,
  displayTitle,
  isHarvest,
  isWithinHours,
  routeIncident,
  siteHours,
  type RoutingRule,
  type SeasonPeriod,
} from '@mercer/core';
import {
  listChannels,
  listDivisions,
  listRoutingRules,
  listSeasons,
  listSites,
  searchIncidents,
} from '@mercer/db';
import { RulesPanel } from '@/components/notify/rules-panel';
import { PriorityBadge } from '@/components/status';
import { Card } from '@/components/ui';
import { server } from '@/lib/server';
import { effectiveConfig } from '@/lib/settings';

export const dynamic = 'force-dynamic';

export default async function RoutingSettings() {
  const cfg = await effectiveConfig();
  const { db } = server();
  const [rules, channels, divisions, sites, seasons, open] = await Promise.all([
    listRoutingRules(db.db),
    listChannels(db.db),
    listDivisions(db.db),
    listSites(db.db),
    listSeasons(db.db),
    searchIncidents(db.db, { status: 'active', limit: 50 }),
  ]);
  const now = new Date();
  const harvest = isHarvest(seasons as unknown as SeasonPeriod[], now, cfg.timezone);
  const siteById = new Map(sites.map((s) => [s.id, s]));
  const asRules: RoutingRule[] = rules;
  const preview = open.rows.map((i) => {
    const site = i.primarySiteId ? siteById.get(i.primarySiteId) : undefined;
    const hours = site
      ? siteHours({ ...site, divisionName: null }, harvest)
      : { days: [1, 2, 3, 4, 5], start: '07:00', end: '17:00' };
    const r = routeIncident(asRules, {
      priority: i.priority,
      kind: i.kind,
      divisionCode: i.divisionCode,
      siteId: i.primarySiteId,
      affectedSiteIds: i.affectedSiteIds,
      withinBusinessHours: isWithinHours(now, hours, cfg.timezone),
    });
    return { id: i.id, priority: i.priority, title: displayTitle(i), seeded: i.seeded, ...r };
  });
  return (
    <div className="space-y-6">
      <Card
        title="Routing rules"
        description="Checked top to bottom for every incident. Every matching rule adds its channel and paging, until a rule marked “stop” matches. Changes apply to the next notification."
      >
        <RulesPanel
          rules={rules.map((r) => ({
            id: r.id,
            name: r.name,
            enabled: r.enabled,
            priorities: r.match.priorities ?? [],
            kinds: r.match.kinds ?? [],
            divisions: r.match.divisions ?? [],
            siteIds: r.match.siteIds ?? [],
            hours: r.match.hours ?? 'any',
            channelKey: r.channelKey,
            pageOncall: r.pageOncall,
            escalateAfterMin: r.escalateAfterMin,
            stop: r.stop,
          }))}
          opts={{
            channels: channels.map((c) => c.key),
            divisions: divisions.map((d) => ({ code: d.code, name: d.name })),
            sites: sites.map((s) => ({ id: s.id, name: s.name })),
            kinds: [...INCIDENT_KINDS],
            defaultEscalate: cfg.notify.escalateAfterMin,
          }}
        />
      </Card>
      <Card
        title="What the rules do with the open incidents now"
        description="A dry run with the current time. Pre-existing incidents are never announced."
      >
        {preview.length === 0 ? (
          <p className="text-sm text-slate-400">No open incidents.</p>
        ) : (
          <ul className="space-y-2 text-sm">
            {preview.map((p) => (
              <li key={p.id} className="flex flex-wrap items-center gap-2">
                <PriorityBadge p={p.priority} />
                <Link href={`/incidents/${p.id}`} className="text-sky-300 hover:underline">
                  {p.title}
                </Link>
                <span className="text-slate-400">
                  →{' '}
                  {p.seeded
                    ? 'not announced (pre-existing)'
                    : [
                        p.channelKeys.map((c) => `#${c}`).join(', ') || 'no channel',
                        p.page ? 'pages on-call' : 'no page',
                      ].join(' · ')}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
