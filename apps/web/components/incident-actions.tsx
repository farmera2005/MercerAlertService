'use client';

import { useActionState, useEffect, useRef, type ReactNode } from 'react';
import { incidentAction, type IncidentActionState } from '@/app/actions/incidents';
import { Alert, Button, Input, Select, Textarea } from './ui';

const SNOOZE = [
  [30, '30 minutes'],
  [60, '1 hour'],
  [120, '2 hours'],
  [240, '4 hours'],
  [480, '8 hours'],
  [1440, '1 day'],
] as const;

function ActionForm({
  incidentId,
  children,
  label,
  className,
}: {
  incidentId: number;
  children: (pending: boolean) => ReactNode;
  label: string;
  className?: string;
}) {
  const [state, action, pending] = useActionState<IncidentActionState, FormData>(
    incidentAction.bind(null, incidentId),
    {},
  );
  const ref = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (state.ok) ref.current?.reset();
  }, [state]);
  return (
    <form ref={ref} action={action} aria-label={label} className={className}>
      {children(pending)}
      {state.message && (
        <div className="mt-2">
          <Alert tone={state.ok ? 'success' : 'error'}>{state.message}</Alert>
        </div>
      )}
    </form>
  );
}

export function IncidentActions({
  incidentId,
  status,
  snoozedUntil,
  activeAlerts,
  focus = null,
}: {
  incidentId: number;
  status: string;
  snoozedUntil: string | null;
  activeAlerts: number;
  /** Arrived from a Teams button: put the cursor on that action (never act automatically). */
  focus?: 'ack' | 'snooze' | null;
}) {
  const open = status === 'open' || status === 'acknowledged';
  const snoozed = !!snoozedUntil && new Date(snoozedUntil).getTime() > Date.now();
  return (
    <div className="space-y-4">
      {status === 'open' && (
        <ActionForm incidentId={incidentId} label="Acknowledge">
          {(pending) => (
            <div className="flex gap-2">
              <input type="hidden" name="action" value="ack" />
              <Input
                name="text"
                placeholder="Comment (optional), e.g. on my way"
                maxLength={500}
                autoFocus={focus === 'ack'}
              />
              <Button type="submit" disabled={pending}>
                {pending ? 'Acknowledging…' : 'Acknowledge'}
              </Button>
            </div>
          )}
        </ActionForm>
      )}
      {open && (
        <div className="flex flex-wrap gap-3">
          {status === 'acknowledged' && (
            <ActionForm incidentId={incidentId} label="Remove acknowledgement">
              {(pending) => (
                <Button
                  type="submit"
                  name="action"
                  value="unack"
                  variant="secondary"
                  disabled={pending}
                >
                  Un-acknowledge
                </Button>
              )}
            </ActionForm>
          )}
          {snoozed ? (
            <ActionForm incidentId={incidentId} label="Cancel snooze">
              {(pending) => (
                <Button
                  type="submit"
                  name="action"
                  value="unsnooze"
                  variant="secondary"
                  disabled={pending}
                >
                  Cancel snooze
                </Button>
              )}
            </ActionForm>
          ) : (
            <ActionForm incidentId={incidentId} label="Snooze" className="flex gap-2">
              {(pending) => (
                <>
                  <input type="hidden" name="action" value="snooze" />
                  <Select
                    name="minutes"
                    defaultValue="60"
                    aria-label="Snooze for"
                    className="w-36"
                    autoFocus={focus === 'snooze'}
                  >
                    {SNOOZE.map(([m, l]) => (
                      <option key={m} value={m}>
                        {l}
                      </option>
                    ))}
                  </Select>
                  <Button type="submit" variant="secondary" disabled={pending}>
                    Snooze
                  </Button>
                </>
              )}
            </ActionForm>
          )}
          <ActionForm incidentId={incidentId} label="Resolve">
            {(pending) => (
              <Button
                type="submit"
                name="action"
                value="resolve"
                variant="secondary"
                disabled={pending}
                onClick={(e) => {
                  if (
                    activeAlerts > 0 &&
                    !window.confirm(
                      `${activeAlerts} alert${activeAlerts === 1 ? ' is' : 's are'} still active in Orion. Resolve anyway? If they clear and fire again, MAS reopens this incident (or opens a new one once it has closed).`,
                    )
                  )
                    e.preventDefault();
                }}
              >
                Resolve
              </Button>
            )}
          </ActionForm>
        </div>
      )}
      <ActionForm incidentId={incidentId} label="Add a note">
        {(pending) => (
          <div className="space-y-2">
            <input type="hidden" name="action" value="note" />
            <Textarea
              name="text"
              rows={2}
              placeholder="Add a note for the timeline (what you checked, ticket numbers, …)"
              maxLength={4000}
              className="font-sans text-sm"
              aria-label="Note"
            />
            <Button type="submit" variant="secondary" disabled={pending}>
              {pending ? 'Saving…' : 'Add note'}
            </Button>
          </div>
        )}
      </ActionForm>
    </div>
  );
}
