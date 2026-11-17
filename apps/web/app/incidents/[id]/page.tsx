import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  buildTimeline,
  displayTitle,
  formatDuration,
  priorityBasis,
  readStoredAiSummary,
} from '@mercer/core';
import { getIncidentDetail, notificationsForIncident } from '@mercer/db';
import { IncidentActions } from '@/components/incident-actions';
import { NotificationLog } from '@/components/notification-log';
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

export default async function IncidentPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ do?: string }>;
}) {
  const user = await requireUser('/incidents');
  const id = Number((await params).id.replace(/^inc-/i, ''));
  if (!Number.isInteger(id) || id <= 0) notFound();
  const cfg = await effectiveConfig();
  const tz = cfg.timezone;
  const [d, notes] = await Promise.all([
    getIncidentDetail(server().db.db, id),
    notificationsForIncident(server().db.db, id),
  ]);
  const requested = (await searchParams).do;
  const intent = requested === 'ack' || requested === 'snooze' ? requested : null;
  if (!d) notFound();
  const inc = d.incident;
  const now = Date.now();
  const open = inc.status === 'open' || inc.status === 'acknowledged';
  const end = inc.resolvedAt ?? (open ? new Date(now) : (inc.closedAt ?? inc.lastActivityAt));
  const durationMs = end.getTime() - inc.openedAt.getTime();
  const targetLeftMs = inc.recoveryTargetMin * 60_000 - durationMs;
  const activeAlerts = d.members.filter((m) => m.record.state === 'active').length;
  const ai = readStoredAiSummary(inc.aiSummary);
  const aiStale = !!ai && open && ai.forMaterialRev < inc.materialRev;
  const aiNote = !cfg.ai.enabled
    ? 'Generated from the correlated alerts. AI summaries are off.'
    : inc.seeded
      ? 'Generated from the correlated alerts. Incidents that existed before MAS started are not summarized.'
      : inc.aiStatus === 'budget_blocked'
        ? 'Generated from the correlated alerts. The daily AI budget is spent; Claude summarizes after midnight.'
        : inc.aiStatus === 'error'
          ? 'Generated from the correlated alerts. Claude could not be reached; MAS will try again.'
          : inc.aiStatus === 'refused' || inc.aiStatus === 'fallback'
            ? 'Generated from the correlated alerts. Claude’s answer could not be used.'
            : 'Generated from the correlated alerts. Claude is writing a summary.';
  const aiApplied =
    inc.aiPriorityAdjust !== null &&
    inc.aiPriorityBasis === priorityBasis(inc.kind, inc.basePriority);
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
                ? `Written by Claude at ${fmtTime(ai.generatedAt, tz)}${aiStale ? ' · describes an earlier state; an update is on its way' : ''}`
                : aiNote
            }
          >
            {ai ? (
              <div className="space-y-4 text-sm" data-testid="ai-summary">
                <p className="leading-relaxed text-slate-100" data-testid="incident-summary">
                  {ai.short}
                </p>
                <dl className="space-y-3">
                  <div>
                    <dt className="text-xs font-semibold uppercase tracking-wide text-slate-400">
                      What is affected
                    </dt>
                    <dd className="mt-1 text-slate-200">{ai.whatIsAffected}</dd>
                  </div>
                  <div>
                    <dt className="text-xs font-semibold uppercase tracking-wide text-slate-400">
                      Likely cause · {ai.confidence} confidence
                    </dt>
                    <dd className="mt-1 text-slate-200">{ai.likelyCause}</dd>
                  </div>
                  <div>
                    <dt className="text-xs font-semibold uppercase tracking-wide text-slate-400">
                      First steps
                    </dt>
                    <dd>
                      <ol className="mt-1 list-decimal space-y-1 pl-5 text-slate-200">
                        {ai.firstSteps.map((step, i) => (
                          <li key={i}>{step}</li>
                        ))}
                      </ol>
                    </dd>
                  </div>
                  {ai.changes !== 'First summary.' && (
                    <div>
                      <dt className="text-xs font-semibold uppercase tracking-wide text-slate-400">
                        What changed
                      </dt>
                      <dd className="mt-1 text-slate-200">{ai.changes}</dd>
                    </div>
                  )}
                </dl>
                <details className="rounded-lg border border-white/10 p-3">
                  <summary className="cursor-pointer text-xs text-slate-400">
                    MAS’s own summary (from the alerts)
                  </summary>
                  <p className="mt-2 leading-relaxed text-slate-300">{inc.templateSummary}</p>
                </details>
                <p className="text-xs text-slate-500">
                  {ai.model}
                  {ai.redacted
                    ? ' · addresses and serial numbers were redacted before sending'
                    : ''}
                  . AI text can be wrong; the alerts and timeline are the record.
                </p>
              </div>
            ) : (
              <p className="text-sm leading-relaxed text-slate-200" data-testid="incident-summary">
                {inc.templateSummary}
              </p>
            )}
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

          <Card
            title={`Notifications (${notes.length})`}
            description="Teams posts, pages and escalations for this incident, including the ones deliberately not sent."
          >
            <NotificationLog rows={notes} tz={tz} />
          </Card>
        </div>

        <div className="space-y-6">
          <Card title="Actions">
            {intent && (
              <div
                className="mb-4 rounded-lg border border-sky-400/50 bg-sky-500/10 p-3 text-sm text-sky-100"
                role="status"
              >
                {inc.status === 'open' || inc.status === 'acknowledged'
                  ? `You came from Teams to ${intent === 'ack' ? 'acknowledge' : 'snooze'} this incident. Confirm below.`
                  : `This incident is already ${inc.status}.`}
              </div>
            )}
            <IncidentActions
              incidentId={inc.id}
              status={inc.status}
              snoozedUntil={inc.snoozedUntil?.toISOString() ?? null}
              activeAlerts={activeAlerts}
              focus={intent}
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
            {inc.aiPrioritySuggested !== null && inc.aiPriorityReason && (
              <div className="mt-4 border-t border-white/10 pt-3 text-sm" data-testid="ai-priority">
                <div className="font-medium text-slate-200">
                  AI second opinion:{' '}
                  {inc.aiPrioritySuggested === 0
                    ? 'keep'
                    : inc.aiPrioritySuggested > 0
                      ? 'one level more urgent'
                      : 'one level less urgent'}
                </div>
                <p className="mt-1 text-slate-300">{inc.aiPriorityReason}</p>
                {aiApplied && inc.priority !== inc.basePriority && (
                  <p className="mt-1 text-xs text-slate-400">
                    Applied: the score gives {inc.basePriority}, the incident is {inc.priority}.
                  </p>
                )}
                {inc.aiPrioritySuggested !== 0 && !aiApplied && !inc.guardrailNote && (
                  <p className="mt-1 text-xs text-slate-400">
                    {cfg.ai.priorityMode === 'apply'
                      ? 'Not applied: the incident changed since.'
                      : 'Not applied: suggestions are shown only (Settings → AI).'}
                  </p>
                )}
              </div>
            )}
            {inc.guardrailNote && (
              <p className="mt-2 text-xs text-amber-200">Guardrail: {inc.guardrailNote}</p>
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
