import { addWeeks, onCallAt, rotationWeekStart, zonedTimeToUtc, type Person } from '@mercer/core';
import { listOncallWeeks, listOverrides, listPeople } from '@mercer/db';
import { OverridesPanel, PeoplePanel, WeeksTable } from '@/components/notify/oncall-panel';
import { Badge, Card } from '@/components/ui';
import { server } from '@/lib/server';
import { effectiveConfig } from '@/lib/settings';

export const dynamic = 'force-dynamic';

const WEEKS_AHEAD = 8;
const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

export default async function OncallSettings() {
  const cfg = await effectiveConfig();
  const tz = cfg.timezone;
  const handoff = cfg.notify.handoff;
  const now = new Date();
  const thisWeek = rotationWeekStart(now, handoff, tz);
  const { db } = server();
  const [peopleRows, weeks, overrides] = await Promise.all([
    listPeople(db.db),
    listOncallWeeks(db.db, thisWeek),
    listOverrides(db.db, now),
  ]);
  const people: Person[] = peopleRows;
  const name = (p: Person | null) => p?.name ?? 'nobody';
  const ctx = {
    people,
    weeks: weeks.map((w) => ({
      weekStart: w.weekStart,
      primaryPersonId: w.primaryPersonId,
      secondaryPersonId: w.secondaryPersonId,
    })),
    handoff,
    timezone: tz,
  };
  const current = onCallAt(now, { ...ctx, overrides });
  const [hh, mm] = handoff.time.split(':').map(Number) as [number, number];
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
  const plan = Array.from({ length: WEEKS_AHEAD }, (_, i) => {
    const weekStart = addWeeks(thisWeek, i);
    const [y, m, d] = weekStart.split('-').map(Number) as [number, number, number];
    const handoffAt = zonedTimeToUtc(y, m, d, hh, mm, 0, 0, tz);
    const chain = onCallAt(new Date(handoffAt.getTime() + 60_000), { ...ctx, overrides: [] });
    const row = weeks.find((w) => w.weekStart === weekStart);
    return {
      weekStart,
      label: fmt.format(handoffAt),
      primaryId: chain.primary?.id ?? null,
      secondaryId: chain.secondary?.id ?? null,
      primaryName: name(chain.primary),
      secondaryName: name(chain.secondary),
      explicit: !!row,
    };
  });
  const byId = new Map(peopleRows.map((p) => [p.id, p]));
  const rangeFmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
  return (
    <div className="space-y-6">
      <Card title="On call now">
        <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
          <dt className="text-slate-400">Primary</dt>
          <dd className="font-medium text-slate-100" data-testid="oncall-primary">
            {name(current.primary)}
            {current.source === 'override' && (
              <span className="ml-2">
                <Badge tone="info">covering</Badge>
              </span>
            )}
          </dd>
          <dt className="text-slate-400">Then (after {cfg.notify.escalateAfterMin} min)</dt>
          <dd>{name(current.secondary)}</dd>
          <dt className="text-slate-400">Finally (after {cfg.notify.escalateAfterMin * 2} min)</dt>
          <dd>{current.leads.map((p) => p.name).join(', ') || 'no IT lead set'}</dd>
        </dl>
        <p className="mt-3 text-xs text-slate-400">
          Weeks hand off on {DAYS[handoff.isoWeekday - 1]}s at {handoff.time} (Settings →
          Notifications → Paging &amp; escalation). People without a rotation number are only paged
          as IT lead or when assigned to a week.
        </p>
      </Card>
      <Card
        title="Next 8 weeks"
        description="Each week follows the rotation order unless you assign it."
      >
        <WeeksTable weeks={plan} people={peopleRows} />
      </Card>
      <Card
        title="Cover"
        description="Someone else takes the primary role for a while (vacation, swaps)."
      >
        <OverridesPanel
          people={peopleRows}
          overrides={overrides.map((o) => ({
            id: o.id,
            personName: byId.get(o.personId)?.name ?? '?',
            label: `${rangeFmt.format(o.startsAt)} → ${rangeFmt.format(o.endsAt)}`,
            reason: o.reason,
          }))}
        />
      </Card>
      <Card title="People" description="Everyone MAS may page, and how.">
        <PeoplePanel
          people={peopleRows}
          providers={{ sms: !!cfg.notify.twilio, pushover: !!cfg.notify.pushover }}
        />
      </Card>
    </div>
  );
}
