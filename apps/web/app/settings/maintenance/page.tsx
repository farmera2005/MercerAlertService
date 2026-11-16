import { asc, isNull } from 'drizzle-orm';
import { isMaintenanceActive } from '@mercer/core';
import { listMaintenance, listSites, orionNodes } from '@mercer/db';
import { MaintenancePanel, type MaintenanceView } from '@/components/maintenance-panel';
import { server } from '@/lib/server';
import { getSettingsState } from '@/lib/settings';

export const dynamic = 'force-dynamic';

const DAYS = ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export default async function MaintenancePage() {
  const { db } = server();
  const tz = (await getSettingsState()).cfg?.timezone ?? 'America/New_York';
  const [windows, sites, nodes] = await Promise.all([
    listMaintenance(db.db),
    listSites(db.db),
    db.db
      .select({ id: orionNodes.nodeId, caption: orionNodes.caption })
      .from(orionNodes)
      .where(isNull(orionNodes.removedAt))
      .orderBy(asc(orionNodes.caption)),
  ]);
  const fmt = (d: Date) =>
    d.toLocaleString('en-US', { timeZone: tz, dateStyle: 'medium', timeStyle: 'short' });
  const siteName = new Map(sites.map((s) => [s.id, s.name]));
  const nodeName = new Map(nodes.map((n) => [n.id, n.caption]));
  const now = new Date();
  const views: MaintenanceView[] = windows.map((w) => {
    const ended = w.endsAt !== null && w.endsAt <= now;
    const state: MaintenanceView['state'] = ended
      ? 'ended'
      : isMaintenanceActive({ ...w, recurrence: w.recurrence ?? null }, now, tz)
        ? 'active'
        : w.startsAt > now
          ? 'upcoming'
          : w.recurrence
            ? 'recurring'
            : 'ended';
    return {
      id: w.id,
      scope: w.scope,
      target:
        w.scope === 'global'
          ? 'Everything'
          : w.scope === 'site'
            ? (siteName.get(w.siteId!) ?? `site ${w.siteId}`)
            : (nodeName.get(w.nodeId!) ?? `node ${w.nodeId}`),
      startsAt: fmt(w.startsAt),
      endsAt: w.endsAt ? fmt(w.endsAt) : null,
      recurrence: w.recurrence
        ? `Every ${w.recurrence.weekdays.map((d) => DAYS[d]).join(', ')} at ${w.recurrence.start} for ${w.recurrence.durationMin} min`
        : null,
      suppress: w.suppress,
      reason: w.reason,
      state,
      createdBy: w.createdBy,
    };
  });
  return (
    <MaintenancePanel
      windows={views}
      sites={sites.map((s) => ({ id: s.id, name: s.name }))}
      nodes={nodes.map((n) => ({ id: n.id, caption: n.caption }))}
      timezone={tz}
    />
  );
}
