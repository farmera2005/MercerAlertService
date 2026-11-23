import Link from 'next/link';
import { NocDesktop } from '@/components/noc/desktop';
import { Shell } from '@/components/shell';
import { cx } from '@/components/ui';
import { requireUser } from '@/lib/auth';
import { listBoardViews, loadBoardData } from '@/lib/noc';

export const dynamic = 'force-dynamic';

/** NOC boards for signed-in people: the built-in boards and the ones admins composed. */
export default async function NocPage({
  searchParams,
}: {
  searchParams: Promise<{ board?: string }>;
}) {
  const user = await requireUser('/noc');
  const { board } = await searchParams;
  const boards = await listBoardViews();
  const view = boards.find((b) => b.ref === board) ?? boards[0]!;
  const data = await loadBoardData(view.definition, 'desktop');
  return (
    <Shell user={user} full>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <h1 className="text-2xl font-semibold">NOC</h1>
        <nav className="flex flex-wrap gap-1 text-sm" aria-label="Boards">
          {boards.map((b) => (
            <Link
              key={b.ref}
              href={`/noc?board=${encodeURIComponent(b.ref)}`}
              aria-current={b.ref === view.ref ? 'page' : undefined}
              className={cx(
                'rounded-md px-3 py-1.5',
                b.ref === view.ref
                  ? 'bg-white/10 text-white'
                  : 'text-slate-400 hover:text-slate-100',
              )}
            >
              {b.name}
            </Link>
          ))}
        </nav>
        {user.isAdmin && (
          <Link href="/settings/noc" className="ml-auto text-sm text-slate-400 hover:text-white">
            Edit boards · show on a wall
          </Link>
        )}
      </div>
      <div className="mt-3">
        <NocDesktop board={view} data={data} />
      </div>
    </Shell>
  );
}
