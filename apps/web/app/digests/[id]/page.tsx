import Link from 'next/link';
import { notFound } from 'next/navigation';
import { digestTitle } from '@mercer/core';
import { getDigest } from '@mercer/db';
import { DigestView } from '@/components/digest-view';
import { Shell } from '@/components/shell';
import { fmtTime } from '@/components/status';
import { Card } from '@/components/ui';
import { requireUser } from '@/lib/auth';
import { server } from '@/lib/server';
import { effectiveConfig } from '@/lib/settings';

export const dynamic = 'force-dynamic';

export default async function DigestPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireUser(`/digests/${id}`);
  const n = Number(id);
  if (!Number.isInteger(n) || n <= 0) notFound();
  const d = await getDigest(server().db.db, n);
  if (!d) notFound();
  const tz = (await effectiveConfig()).timezone;
  return (
    <Shell user={user}>
      <Link href="/digests" className="text-sm text-slate-400 hover:text-white">
        ← Digests
      </Link>
      <h1 className="mt-2 text-2xl font-semibold" data-testid="digest-title">
        {digestTitle(d.facts)}
      </h1>
      <p className="mt-1 text-sm text-slate-400">Written {fmtTime(d.createdAt, tz)}</p>
      <Card className="mt-6">
        <DigestView content={d.content} facts={d.facts} source={d.source} />
      </Card>
      <details className="mt-4 rounded-xl border border-white/10 p-4 open:bg-white/[0.02]">
        <summary className="cursor-pointer text-sm text-slate-300">Markdown</summary>
        <pre className="mt-3 overflow-x-auto whitespace-pre-wrap text-xs text-slate-300">
          {d.markdown}
        </pre>
      </details>
    </Shell>
  );
}
