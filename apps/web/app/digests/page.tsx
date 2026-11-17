import Link from 'next/link';
import { listDigests } from '@mercer/db';
import { Shell } from '@/components/shell';
import { fmtTime } from '@/components/status';
import { Badge, Card } from '@/components/ui';
import { requireUser } from '@/lib/auth';
import { server } from '@/lib/server';
import { effectiveConfig } from '@/lib/settings';

export const dynamic = 'force-dynamic';

const SENT: Record<string, { tone: 'ok' | 'warn' | 'bad' | 'neutral'; label: string }> = {
  sent: { tone: 'ok', label: 'posted' },
  queued: { tone: 'neutral', label: 'posting' },
  failed: { tone: 'bad', label: 'post failed' },
  suppressed: { tone: 'warn', label: 'not posted' },
};

export default async function DigestsPage() {
  const user = await requireUser('/digests');
  const tz = (await effectiveConfig()).timezone;
  const rows = await listDigests(server().db.db, 90);
  return (
    <Shell user={user}>
      <h1 className="text-2xl font-semibold">Digests</h1>
      <p className="mt-1 text-sm text-slate-400">
        The morning digest and the weekly trends report, as posted to Teams.
      </p>
      <Card className="mt-6">
        {rows.length === 0 ? (
          <p className="text-sm text-slate-400">
            No digests yet. The first daily digest is written at the scheduled time
            {user.isAdmin && (
              <>
                {' '}
                (or send one now from{' '}
                <Link className="underline" href="/settings/digests">
                  Settings → Digests
                </Link>
                )
              </>
            )}
            .
          </p>
        ) : (
          <ul className="divide-y divide-white/5" data-testid="digest-list">
            {rows.map((d) => {
              const sent = d.notificationStatus ? SENT[d.notificationStatus] : undefined;
              return (
                <li key={d.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-3">
                  <Link
                    href={`/digests/${d.id}`}
                    className="font-medium text-sky-300 hover:underline"
                  >
                    {d.kind === 'daily' ? 'Daily' : 'Weekly'} · {fmtTime(d.periodEnd, tz)}
                  </Link>
                  <span className="min-w-0 flex-1 text-sm text-slate-300">{d.headline}</span>
                  <Badge tone={d.source === 'ai' ? 'info' : 'neutral'}>
                    {d.source === 'ai' ? 'Claude' : 'template'}
                  </Badge>
                  {sent && <Badge tone={sent.tone}>{sent.label}</Badge>}
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </Shell>
  );
}
