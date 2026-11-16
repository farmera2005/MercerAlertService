import { redirect } from 'next/navigation';
import { countActiveAccounts } from '@mercer/db';
import { ClaimForm } from '@/components/claim-form';
import { Card } from '@/components/ui';
import { currentUser } from '@/lib/auth';
import { server } from '@/lib/server';
import { ensureSetupCode } from '@/lib/setup-code';

export const dynamic = 'force-dynamic';

export default async function SetupStart() {
  if ((await countActiveAccounts(server().db.db)) > 0) {
    redirect((await currentUser()) ? '/setup/orion' : '/login?next=/setup/orion');
  }
  await ensureSetupCode({ announce: true }); // re-print so it is near the end of the log
  return (
    <main className="mx-auto max-w-xl px-6 py-16">
      <h1 className="text-3xl font-semibold">Set up MercerAlertService</h1>
      <p className="mt-3 text-slate-400">
        Everything is configured here in the browser: the SolarWinds connection, site mapping and
        polling. First, create the administrator account. The one-time setup code proves you have
        access to the server.
      </p>
      <Card className="mt-8">
        <ClaimForm />
      </Card>
    </main>
  );
}
