'use client';

import { useActionState } from 'react';
import { claimSetupAction, type AuthFormState } from '@/app/actions/auth';
import { Alert, Button, FieldShell, Input } from './ui';

export function ClaimForm() {
  const [state, action, pending] = useActionState<AuthFormState, FormData>(claimSetupAction, {});
  const e = state.errors ?? {};
  return (
    <form action={action} className="space-y-5" noValidate>
      <FieldShell
        id="setupCode"
        label="Setup code"
        error={e.setupCode}
        help={
          <>
            Printed in the server log. On the server, run{' '}
            <code className="text-slate-300">
              docker compose logs web | grep -i &quot;setup code&quot;
            </code>
          </>
        }
      >
        <Input
          id="setupCode"
          name="setupCode"
          autoComplete="one-time-code"
          placeholder="XXXX-XXXX"
          defaultValue={state.values?.setupCode}
          className="font-mono uppercase tracking-widest"
        />
      </FieldShell>
      <FieldShell id="username" label="Administrator username" error={e.username}>
        <Input
          id="username"
          name="username"
          autoComplete="username"
          placeholder="it-admin"
          defaultValue={state.values?.username}
        />
      </FieldShell>
      <div className="grid gap-5 sm:grid-cols-2">
        <FieldShell
          id="password"
          label="Password"
          error={e.password}
          help="At least 12 characters."
        >
          <Input id="password" name="password" type="password" autoComplete="new-password" />
        </FieldShell>
        <FieldShell id="confirm" label="Confirm password" error={e.confirm}>
          <Input id="confirm" name="confirm" type="password" autoComplete="new-password" />
        </FieldShell>
      </div>
      {state.message && <Alert tone="error">{state.message}</Alert>}
      <Button type="submit" disabled={pending} className="w-full">
        {pending ? 'Creating…' : 'Create administrator and continue'}
      </Button>
    </form>
  );
}
