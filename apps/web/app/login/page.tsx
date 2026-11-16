import { redirect } from 'next/navigation';
import { ENTRA_DENY_MESSAGES, type EntraDenyReason } from '@mercer/core';
import { countActiveAccounts } from '@mercer/db';
import { microsoftSignInAction } from '@/app/actions/auth';
import { LoginForm } from '@/components/login-form';
import { Alert, Button, Card } from '@/components/ui';
import { currentUser } from '@/lib/auth';
import { server } from '@/lib/server';
import { effectiveConfig } from '@/lib/settings';

export const dynamic = 'force-dynamic';

function errorText(code: string | undefined): string | null {
  if (!code) return null;
  if (code in ENTRA_DENY_MESSAGES) return ENTRA_DENY_MESSAGES[code as EntraDenyReason];
  if (code === 'disabled') return 'Your account has been disabled in this dashboard.';
  if (code === 'AccessDenied') return 'Microsoft sign-in was cancelled or refused.';
  return 'Microsoft sign-in failed. An administrator can check Settings → Sign-in and the web log.';
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; error?: string }>;
}) {
  if ((await countActiveAccounts(server().db.db)) === 0) redirect('/setup');
  const { next: rawNext, error } = await searchParams;
  const next = rawNext && rawNext.startsWith('/') && !rawNext.startsWith('//') ? rawNext : '/';
  if (!error && (await currentUser())) redirect(next);
  const sso = !!(await effectiveConfig()).auth.entra;
  const message = errorText(error);
  return (
    <main className="mx-auto max-w-sm px-6 py-20">
      <h1 className="text-2xl font-semibold">Sign in</h1>
      <p className="mt-2 text-sm text-slate-400">Mercer Landmark · Network Status</p>
      {message && (
        <div className="mt-6">
          <Alert tone="error">{message}</Alert>
        </div>
      )}
      {sso && (
        <Card className="mt-6">
          <form action={microsoftSignInAction}>
            <input type="hidden" name="next" value={next} />
            <Button type="submit" className="w-full">
              Sign in with Microsoft
            </Button>
          </form>
        </Card>
      )}
      {sso ? (
        <details className="mt-6 rounded-xl border border-white/10 p-4">
          <summary className="cursor-pointer text-sm text-slate-400">
            Local administrator sign-in
          </summary>
          <div className="mt-4">
            <LoginForm next={next} />
          </div>
        </details>
      ) : (
        <Card className="mt-6">
          <LoginForm next={next} />
        </Card>
      )}
    </main>
  );
}
