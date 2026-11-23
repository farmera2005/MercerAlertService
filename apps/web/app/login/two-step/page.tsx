import { redirect } from 'next/navigation';
import { passkeysForAccount } from '@mercer/db';
import { completeSignInAction } from '@/app/actions/two-factor';
import { PasskeyAdd, SecondStep, TotpSetup } from '@/components/two-factor';
import { Alert, Button, Card } from '@/components/ui';
import { currentUser } from '@/lib/auth';
import { requestMeta } from '@/lib/request';
import { server } from '@/lib/server';
import { deviceLabel, pendingSignIn, webauthnContext } from '@/lib/two-factor';

export const dynamic = 'force-dynamic';

/** After the password: the second step, or setting one up when Settings require it. */
export default async function TwoStepPage() {
  const p = await pendingSignIn();
  if (!p) redirect((await currentUser()) ? '/' : '/login?error=expired');
  const meta = await requestMeta();
  const ctx = webauthnContext(meta);
  const keys = await passkeysForAccount(server().db.db, p.account.id);
  const here = ctx.usable ? keys.filter((k) => k.rpId === ctx.rpId).length : 0;
  const elsewhere = [...new Set(keys.map((k) => k.rpId))].filter(
    (rp) => !ctx.usable || rp !== ctx.rpId,
  );

  if (p.mode === 'enroll')
    return (
      <main className="mx-auto max-w-2xl px-6 py-16">
        <h1 className="text-2xl font-semibold">Set up two-step sign-in</h1>
        <p className="mt-2 text-sm text-slate-400">
          Signing in as <b className="text-slate-200">{p.account.username}</b>. This dashboard
          requires a second step after the password. Set up one of these to continue; you can add
          the other later under Account security.
        </p>
        <Card className="mt-6" title="Authenticator app">
          <TotpSetup />
        </Card>
        <Card
          className="mt-6"
          title="Passkey or security key"
          description="Windows Hello, Touch ID, a phone, or a key such as a YubiKey."
        >
          {ctx.usable ? (
            <PasskeyAdd suggestedName={deviceLabel(meta.userAgent)} />
          ) : (
            <p className="text-sm text-slate-400">{ctx.why}</p>
          )}
        </Card>
      </main>
    );

  return (
    <main className="mx-auto max-w-sm px-6 py-20">
      <h1 className="text-2xl font-semibold">Two-step sign-in</h1>
      <p className="mt-2 text-sm text-slate-400">
        Signing in as <b className="text-slate-200">{p.account.username}</b>. Confirm it’s you.
      </p>
      <Card className="mt-6">
        {p.mode === 'done' ? (
          <div className="space-y-4">
            <Alert tone="info">No second step is needed for this account any more.</Alert>
            <form action={completeSignInAction}>
              <Button type="submit" className="w-full">
                Continue
              </Button>
            </form>
          </div>
        ) : (
          <SecondStep
            hasTotp={p.status.totp}
            passkeysHere={here}
            passkeysElsewhere={elsewhere}
            recoveryLeft={p.status.recoveryCodesLeft}
          />
        )}
      </Card>
    </main>
  );
}
