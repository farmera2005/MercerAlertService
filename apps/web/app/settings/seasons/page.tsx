import { listDivisions, listSeasons } from '@mercer/db';
import { SeasonsPanel } from '@/components/seasons-panel';
import { server } from '@/lib/server';

export const dynamic = 'force-dynamic';

export default async function SeasonsPage() {
  const { db } = server();
  const [seasons, divisions] = await Promise.all([listSeasons(db.db), listDivisions(db.db)]);
  return (
    <SeasonsPanel
      seasons={seasons}
      divisions={divisions.map((d) => ({ code: d.code, name: d.name }))}
    />
  );
}
