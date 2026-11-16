'use client';

import { useActionState } from 'react';
import { loginAction, type AuthFormState } from '@/app/actions/auth';
import { Alert, Button, FieldShell, Input } from './ui';

export function LoginForm({ next }: { next: string }) {
  const [state, action, pending] = useActionState<AuthFormState, FormData>(loginAction, {});
  return (
    <form action={action} className="space-y-5" noValidate>
      <input type="hidden" name="next" value={next} />
      <FieldShell id="username" label="Username">
        <Input
          id="username"
          name="username"
          autoComplete="username"
          defaultValue={state.values?.username}
        />
      </FieldShell>
      <FieldShell id="password" label="Password">
        <Input id="password" name="password" type="password" autoComplete="current-password" />
      </FieldShell>
      {state.message && <Alert tone="error">{state.message}</Alert>}
      <Button type="submit" disabled={pending} className="w-full">
        {pending ? 'Signing in…' : 'Sign in'}
      </Button>
    </form>
  );
}
