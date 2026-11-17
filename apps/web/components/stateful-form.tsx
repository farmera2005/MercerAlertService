'use client';

import { useActionState, useEffect, useRef, type ReactNode } from 'react';
import { Alert } from './ui';

export interface ActionResult {
  ok?: boolean;
  message?: string;
  errors?: Record<string, string>;
  at?: number;
}

/** A form bound to a server action, showing its result; optionally cleared after success. */
export function StatefulForm({
  action,
  children,
  label,
  className,
  resetOnSuccess = false,
}: {
  action: (state: ActionResult, form: FormData) => Promise<ActionResult>;
  children: (state: ActionResult, pending: boolean) => ReactNode;
  label: string;
  className?: string;
  resetOnSuccess?: boolean;
}) {
  const [state, run, pending] = useActionState<ActionResult, FormData>(action, {});
  const ref = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (state.ok && resetOnSuccess) ref.current?.reset();
  }, [state, resetOnSuccess]);
  return (
    <form ref={ref} action={run} aria-label={label} className={className} noValidate>
      {children(state, pending)}
      {state.message && (
        <div className="mt-3">
          <Alert tone={state.ok ? 'success' : 'error'}>{state.message}</Alert>
        </div>
      )}
    </form>
  );
}
