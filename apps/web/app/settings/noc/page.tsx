import { listDivisions, listNocBoards, listSites } from '@mercer/db';
import { NocBoardsPanel } from '@/components/noc/builder';
import { server } from '@/lib/server';

export const dynamic = 'force-dynamic';

export default async function NocBoardsSettings() {
  const { db } = server();
  const [boards, divisions, sites] = await Promise.all([
    listNocBoards(db.db),
    listDivisions(db.db),
    listSites(db.db),
  ]);
  return (
    <NocBoardsPanel
      boards={boards.map((b) => ({
        id: b.id,
        name: b.name,
        definition: b.definition,
        updatedBy: b.updatedBy,
        updatedAt: b.updatedAt.toISOString(),
      }))}
      options={{
        divisions: divisions.map((d) => ({ code: d.code, name: d.name })),
        sites: sites.map((s) => ({ id: s.id, name: s.name })),
      }}
    />
  );
}
