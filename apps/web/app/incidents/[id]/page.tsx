import Link from 'next/link';
import { notFound } from 'next/navigation';
import { buildTimeline, displayTitle, formatDuration } from '@mercer/core';
import { getIncidentDetail } from '@mercer/db';
import { IncidentActions } from '@/components/incident-actions';
import { Shell } from '@/components/shell';
import {
  fmtTime,
  IncidentStatusBadge,
  KIND_LABEL,
  NodeStatus,
  PriorityBadge,
  ROLE_LABEL,
  pct,
  ifaceLabel,
} from '@/components/status';
import { Timeline } from '@/components/timeline';
import { Badge, Card } from '@/components/ui';
import { requireUser } from '@/lib/auth';
import { server } from '@/lib/server';
import { effectiveConfig } from '@/lib/settings';

export const dynamic = 'force-dynamic';

const MEMBER_ROLE: Record<string, string> = {
  root: 'Root cause',
  symptom: 'Symptom',
  member: 'Related',
};

interface AiSummary {
  whatIsAffected?: string;
  likelyCause?: string;
  confidence?: string;
  firstSteps?: string[];
  changes?: string;
}

export default async function IncidentPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser('/incidents');
  const id = Number((await params).id.replace(/^inc-/i, ''));
  if (!Number.isInteger(id) || id <= 0) notFound();
  const cfg = await effectiveConfig();
  const tz = cfg.timezone;
  const d = await getIncidentDetail(server().db.db, id);
  if (!d) notFound();
  const inc = d.incident;
  const now = Date.now();
  const open = inc.status === 'open' || inc.status === 'acknowledged';
  const end = inc.resolvedAt ?? (open ? new Date(now) : (inc.closedAt ?? inc.lastActivityAt));
  const durationMs = end.getTime() - inc.openedAt.getTime();
  const targetLeftMs = inc.recoveryTargetMin * 60_000 - durationMs;
  const activeAlerts = d.members.filter((m) => m.record.state === 'active').length;
  const ai = (inc.aiSummary ?? null) as AiSummary | null;
  const timeline = buildTimeline(d.timelineInput).map((e) => ({
    ...e,
    at: e.at.toISOString(),
    time: fmtTime(e.at, tz),
  }));
  const snoozed = inc.snoozedUntil && inc.snoozedUntil.getTime() > now;

  return (
    <Shell user={user} wide>
      <nav className="text-sm text-slate-400">
        <Link href="/incidents" className="hover:text-white">
          Incidents
        </Link>{' '}
        / INC-{inc.id}
      </nav>
      <header className="mt-3 flex flex-wrap items-start gap-3">
        <PriorityBadge p={inc.priority} size="lg" />
        <div className="min-w-0 flex-1">
          <h1 className="text-2xl font-semibold" data-testid="incident-title">
            {displayTitle(inc)}
          </h1>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-sm text-slate-400">
            <IncidentStatusBadge status={inc.status} />
            {snoozed && <Badge tone="info">snoozed until {fmtTime(inc.snoozedUntil, tz)}</Badge>}
            {inc.inMaintenance && <Badge tone="info">maintenance window</Badge>}
            {inc.seeded && <Badge>pre-existing at startup</Badge>}
            <span>{KIND_LABEL[inc.kind] ?? inc.kind}</span>
            {d.site && (
              <Link
                href={`/sites/${encodeURIComponent(d.site.code)}`}
                className="text-sky-300 hover:underline"
              >
                {d.site.name}
              </Link>
            )}
            {d.divisionName && <span>· {d.divisionName}</span>}
            <span>· INC-{inc.id}</span>
          </div>
        </div>
      </header>

      <div className="mt-6 grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <Card
            title="Summary"
            description={
              ai
                ? 'AI summary'
                : 'Generated from the correlated alerts (AI summaries arrive in a later release).'
            }
          >
            <p className="text-sm leading-relaxed text-slate-200" data-testid="incident-summary">
              {inc.templateSummary}
            </p>
            {ai?.likelyCause && (
              <p className="mt-3 text-sm text-slate-300">
                <b>Likely cause:</b> {ai.likelyCause}
                {ai.confidence ? ` (${ai.confidence} confidence)` : ''}
              </p>
            )}
            {ai?.firstSteps?.length ? (
              <ol className="mt-3 list-decimal space-y-1 pl-5 text-sm text-slate-300">
                {ai.firstSteps.map((s, i) => (
                  <li key={i}>{s}</li>
                ))}
              </ol>
            ) : null}
          </Card>

          <Card
            title={`Alerts (${d.members.length})`}
            description={`${activeAlerts} still active in Orion.`}
          >
            <div className="max-h-[28rem] overflow-auto">
              <table className="w-full text-left text-sm">
                <thead className="sticky top-0 bg-[#12161b] text-xs text-slate-400">
                  <tr>
                    <th className="py-2 pr-3">Role</th>
                    <th className="pr-3">Alert</th>
                    <th className="pr-3">Entity</th>
                    <th className="pr-3">State</th>
                    <th className="pr-3 text-right">Triggers</th>
                    <th>Last raised</th>
                  </tr>
                </thead>
                <tbody>
                  {d.members.map((m) => (
                    <tr key={m.record.id} className="border-t border-white/5 align-top">
                      <td className="py-1.5 pr-3">
                        <Badge tone={m.role === 'root' ? 'bad' : 'neutral'}>
                          {MEMBER_ROLE[m.role]}
                        </Badge>
                      </td>
                      <td className="pr-3 text-slate-200">{m.record.alertName}</td>
                      <td className="pr-3">
                        {m.record.nodeId ? (
                          <Link
                            href={`/nodes/${m.record.nodeId}`}
                            className="text-sky-300 hover:underline"
                          >
                            {m.record.entityCaption ?? `Node ${m.record.nodeId}`}
                          </Link>
                        ) : (
                          (m.record.entityCaption ?? '—')
                        )}
                      </td>
                      <td className="pr-3">
                        {m.record.state === 'active' ? (
                          <Badge tone="bad">active</Badge>
                        ) : (
                          <Badge tone="ok">cleared</Badge>
                        )}
                      </td>
                      <td className="pr-3 text-right tabular-nums">{m.record.triggerCount}</td>
                      <td className="text-xs text-slate-400">
                        {fmtTime(m.record.lastRaisedAt, tz)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>

          <Card
            title="Timeline"
            description="What Orion reported and what MAS and people did, in order."
          >
            <Timeline rows={timeline} />
          </Card>
        </div>

        <div className="space-y-6">
          <Card title="Actions">
            <IncidentActions
              incidentId={inc.id}
              status={inc.status}
              snoozedUntil={inc.snoozedUntil?.toISOString() ?? null}
              activeAlerts={activeAlerts}
            />
            {inc.acknowledgedBy && inc.status === 'acknowledged' && (
              <p className="mt-3 text-xs text-slate-400">
                Acknowledged by {inc.acknowledgedBy} at {fmtTime(inc.acknowledgedAt, tz)}
              </p>
            )}
          </Card>

          <Card title="Timing">
            <dl className="grid grid-cols-2 gap-y-2 text-sm">
              <dt className="text-slate-400">Opened</dt>
              <dd>{fmtTime(inc.openedAt, tz)}</dd>
              <dt className="text-slate-400">{open ? 'Open for' : 'Lasted'}</dt>
              <dd>{formatDuration(durationMs)}</dd>
              <dt className="text-slate-400">Recovery target</dt>
              <dd>
                {formatDuration(inc.recoveryTargetMin * 60_000)}
                {open && (
                  <span
                    className={`block text-xs ${targetLeftMs < 0 ? 'text-red-300' : 'text-slate-400'}`}
                  >
                    {targetLeftMs < 0
                      ? `${formatDuration(-targetLeftMs)} over`
                      : `${formatDuration(targetLeftMs)} left`}
                  </span>
                )}
              </dd>
              {inc.resolvedAt && (
                <>
                  <dt className="text-slate-400">Resolved</dt>
                  <dd>
                    {fmtTime(inc.resolvedAt, tz)}
                    <span className="block text-xs text-slate-400">
                      {inc.resolvedBy === 'auto'
                        ? 'automatically'
                        : inc.resolvedBy?.replace(/^user:/, 'by ')}
                    </span>
                  </dd>
                </>
              )}
            </dl>
          </Card>

          <Card
            title={`Priority ${inc.priority}`}
            description={`Score ${Math.round(inc.baseScore)} (deterministic)`}
          >
            <ul className="space-y-1 text-sm text-slate-300">
              {inc.priorityFactors.explanation.map((x, i) => (
                <li key={i}>{x}</li>
              ))}
            </ul>
            {inc.aiPriorityReason && (
              <p className="mt-3 text-sm text-slate-300">
                AI suggestion ({inc.aiPriorityAdjust && inc.aiPriorityAdjust > 0 ? '+' : ''}
                {inc.aiPriorityAdjust}): {inc.aiPriorityReason}
              </p>
            )}
            {inc.guardrailNote && (
              <p className="mt-2 text-xs text-amber-200">{inc.guardrailNote}</p>
            )}
          </Card>

          <Card title={`Affected devices (${d.affectedNodes.length})`}>
            <ul className="space-y-2 text-sm">
              {d.affectedNodes.map(({ node }) => (
                <li key={node.nodeId} className="flex items-center justify-between gap-2">
                  <Link
                    href={`/nodes/${node.nodeId}`}
                    className="min-w-0 truncate text-sky-300 hover:underline"
                  >
                    {node.caption}
                  </Link>
                  <span className="flex shrink-0 items-center gap-2 text-xs text-slate-400">
                    {ROLE_LABEL[node.deviceRole] ?? node.deviceRole}
                    <NodeStatus status={node.statusNorm} />
                  </span>
                </li>
              ))}
            </ul>
            {d.affectedInterfaces.length > 0 && (
              <>
                <h3 className="mt-4 text-xs font-semibold uppercase tracking-wide text-slate-400">
                  Interfaces
                </h3>
                <ul className="mt-2 space-y-2 text-sm">
                  {d.affectedInterfaces.map(({ iface, nodeCaption }) => (
                    <li key={iface.interfaceId} className="flex items-center justify-between gap-2">
                      <Link
                        href={`/interfaces/${iface.interfaceId}`}
                        className="min-w-0 truncate text-sky-300 hover:underline"
                      >
                        {nodeCaption} · {ifaceLabel(iface)}
                      </Link>
                      <span className="flex shrink-0 items-center gap-2 text-xs text-slate-400">
                        in {pct(iface.inPercentUtil)} / out {pct(iface.outPercentUtil)}
                        <NodeStatus status={iface.statusNorm} />
                      </span>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </Card>
        </div>
      </div>
    </Shell>
  );
}
