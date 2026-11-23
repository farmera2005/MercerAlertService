'use server';

import { revalidatePath } from 'next/cache';
import { deleteNocBoard, saveNocBoard } from '@mercer/db';
import { adminActor } from '@/lib/auth';
import { server } from '@/lib/server';

export interface NocBoardFormState {
  ok?: boolean;
  message?: string;
  /** The saved board's id (a new board's, after the first save). */
  id?: number;
}

/** Create or update a custom NOC board (Settings → NOC boards); validated and audited. */
export async function saveNocBoardAction(
  _: NocBoardFormState,
  form: FormData,
): Promise<NocBoardFormState> {
  const actor = await adminActor();
  if (!actor) return { ok: false, message: 'Only administrators can change NOC boards.' };
  const id = Number(form.get('id') ?? 0) || undefined;
  let definition: unknown;
  try {
    definition = JSON.parse(String(form.get('definition') ?? ''));
  } catch {
    return { ok: false, message: 'The board could not be read.' };
  }
  const r = await saveNocBoard(
    server().db.db,
    { id, name: String(form.get('name') ?? ''), definition },
    actor,
  );
  if (!r.ok) return { ok: false, message: r.error, id };
  revalidatePath('/settings/noc');
  revalidatePath('/noc');
  return { ok: true, message: `Saved “${r.board.name}”.`, id: r.board.id };
}

export async function deleteNocBoardAction(form: FormData): Promise<void> {
  const actor = await adminActor();
  if (!actor) return;
  const id = Number(form.get('id'));
  if (!Number.isInteger(id) || id <= 0) return;
  await deleteNocBoard(server().db.db, id, actor);
  revalidatePath('/settings/noc');
  revalidatePath('/noc');
  revalidatePath('/settings/wall');
}
