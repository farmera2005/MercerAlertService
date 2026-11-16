'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { INCIDENT_ACTIONS, NOTE_MAX_CHARS, SNOOZE_OPTIONS_MIN } from '@mercer/core';
import { applyIncidentAction } from '@mercer/db';
import { userActor } from '@/lib/auth';
import { requestOrionAck } from '@/lib/writeback';
import { server } from '@/lib/server';

export interface IncidentActionState {
  ok?: boolean;
  message?: string;
  /** Changes on every result so the form can clear its inputs after success. */
  at?: number;
}

const bodySchema = z.object({
  action: z.enum(INCIDENT_ACTIONS),
  minutes: z.coerce
    .number()
    .int()
    .refine((m) => (SNOOZE_OPTIONS_MIN as readonly number[]).includes(m))
    .optional(),
  text: z.string().max(NOTE_MAX_CHARS).optional(),
});

const DONE: Record<string, string> = {
  ack: 'Acknowledged.',
  unack: 'Acknowledgement removed.',
  snooze: 'Snoozed.',
  unsnooze: 'Snooze cancelled.',
  resolve: 'Resolved.',
  note: 'Note added.',
};

/** Ack / snooze / resolve / note from the dashboard: any signed-in user, always audited. */
export async function incidentAction(
  incidentId: number,
  _: IncidentActionState,
  form: FormData,
): Promise<IncidentActionState> {
  const actor = await userActor();
  if (!actor) return { ok: false, message: 'Your session has expired. Sign in again.' };
  const parsed = bodySchema.safeParse({
    action: form.get('action'),
    minutes: form.get('minutes') || undefined,
    text: (form.get('text') as string | null) ?? undefined,
  });
  if (!parsed.success) return { ok: false, message: 'That request was not valid.', at: Date.now() };
  const res = await applyIncidentAction(server().db.db, incidentId, parsed.data, actor);
  if (!res.ok) return { ok: false, message: res.error, at: Date.now() };
  let message = DONE[parsed.data.action]!;
  if (parsed.data.action === 'ack' && res.activeOrionAlerts > 0) {
    const wb = await requestOrionAck(incidentId, actor.display);
    if (wb) message += ` ${wb}`;
  }
  revalidatePath(`/incidents/${incidentId}`);
  return { ok: true, message, at: Date.now() };
}
