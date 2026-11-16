'use client';

import { useActionState } from 'react';
import { finishSetupAction, type FormState } from '@/app/actions/settings';
import { Alert, Button } from './ui';

export function FinishForm({ ready, warnings }: { ready: boolean; warnings: number }) {
  const [state, action, pending] = useActionState<FormState>(finishSetupAction, {});
  return (
    <form action={action} className="space-y-4">
      {state.message && <Alert tone="error">{state.message}</Alert>}
      <Button type="submit" disabled={!ready || pending}>
        {pending ? 'Starting…' : warnings ? 'Start monitoring anyway' : 'Start monitoring'}
      </Button>
      {!ready && <p className="text-sm text-slate-400">Save a SolarWinds connection first.</p>}
    </form>
  );
}
