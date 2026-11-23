import Link from 'next/link';
import { getTwoFactorStatus } from '@mercer/db';
import { Shell } from '@/components/shell';
import {
  NewRecoveryCodes,
  PasskeyAdd,
  RemovePasskeyButton,
  RemoveTotpButton,
  TotpSetup,
} from '@/components/two-factor';
import { Alert, Badge, Card } from '@/components/ui';
import { requireSignedIn } from '@/lib/auth';
import { requestMeta } from '@/lib/request';
import { server } from '@/lib/server';
import { effectiveConfig } from '@/lib/settings';
import { deviceLabel, webauthnContext } from '@/lib/two-factor';

export const dynamic = 'force-dynamic';

export default async function AccountSecurityPage({
  searchParams,
}: {
  searchParams: Promise<{ recovery_left?: string }>;
}) {
  const user = await requireSignedIn();
  const cfg = await effectiveConfig();
  const when = (d: Date | null) =>
    d ? d.toLocaleString('en-US', { timeZone: cfg.timezone }) : 'never';

  if (user.kind !== 'local')
    return (
      <Shell user={user}>
        <h1 className="text-2xl font-semibold">Account security</h1>
        <Card className="mt-6">
          <p className="text-sm text-slate-300">
            You sign in with Microsoft, so your password and multi-factor sign-in are managed by
            your organisation in Microsoft Entra ID, not here.
          </p>
        </Card>
      </Shell>
    );

  const [status, meta, { recovery_left }] = await Promise.all([
    getTwoFactorStatus(server().db.db, user.id),
    requestMeta(),
    searchParams,
  ]);
  const ctx = webauthnContext(meta);
  const required = cfg.auth.require2fa;
  const has = status.totp || status.passkeys > 0;
  const lastOne = required && Number(status.totp) + status.passkeys === 1;

  return (
    <Shell user={user}>
      <h1 className="text-2xl font-semibold">Account security</h1>
      <p className="mt-1 text-sm text-slate-400">
        Two-step sign-in for <b className="text-slate-200">{user.username}</b>: after the password,
        confirm with an authenticator app or a passkey.
      </p>
      <div className="mt-6 space-y-6" data-testid="account-security">
        {user.needsTwoFactor && (
          <Alert tone="warning" title="Two-step sign-in is required">
            This dashboard requires a second step for local accounts. Set up an authenticator app or
            a passkey below to continue.
          </Alert>
        )}
        {!user.needsTwoFactor && required && has && (
          <Alert tone="success">
            Two-step sign-in is on.{' '}
            <Link href="/" className="underline">
              Go to the dashboard
            </Link>
          </Alert>
        )}
        {recovery_left !== undefined && (
          <Alert tone="warning">
            You have {Number(recovery_left) || 0} recovery codes left. Make new ones below.
          </Alert>
        )}

        <Card
          title={
            <span className="flex items-center gap-2">
              Authenticator app {status.totp ? <Badge tone="ok">on</Badge> : <Badge>off</Badge>}
            </span>
          }
          description="Six-digit codes from Microsoft Authenticator, Google Authenticator, 1Password or a similar app. Works on any address MAS is reached at."
        >
          {status.totp ? (
            <div className="space-y-4">
              <p className="text-sm text-slate-400">Set up {when(status.totpEnabledAt)}.</p>
              <div className="flex flex-wrap items-start gap-3">
                <TotpSetup replace />
                <RemoveTotpButton blocked={lastOne} />
              </div>
            </div>
          ) : (
            <TotpSetup />
          )}
        </Card>

        <Card
          title="Passkeys and security keys"
          description="Windows Hello, Touch ID, a phone, or a key such as a YubiKey. A passkey works only on the address it was made on."
        >
          <div className="space-y-4">
            {status.passkeyList.length > 0 && (
              <ul
                className="divide-y divide-white/10 rounded-lg border border-white/10"
                data-testid="passkey-list"
              >
                {status.passkeyList.map((k) => (
                  <li key={k.id} className="flex flex-wrap items-center gap-3 p-3 text-sm">
                    <span className="font-medium text-slate-100">{k.name}</span>
                    <span className="text-slate-400">{k.rpId}</span>
                    {k.backedUp && <Badge tone="info">synced</Badge>}
                    <span className="text-slate-500">
                      added {when(k.createdAt)}, last used {when(k.lastUsedAt)}
                    </span>
                    <RemovePasskeyButton id={k.id} name={k.name} blocked={lastOne} />
                  </li>
                ))}
              </ul>
            )}
            {ctx.usable ? (
              <PasskeyAdd suggestedName={deviceLabel(meta.userAgent)} />
            ) : (
              <p className="text-sm text-slate-400">{ctx.why}</p>
            )}
          </div>
        </Card>

        <Card
          title="Recovery codes"
          description="One-time codes for when the phone or key is lost. Made when you set up your first second step."
        >
          {has ? (
            <div className="space-y-3">
              <p className="text-sm text-slate-300" data-testid="recovery-left">
                {status.recoveryCodesLeft} of 10 left.
              </p>
              <NewRecoveryCodes />
            </div>
          ) : (
            <p className="text-sm text-slate-400">None yet.</p>
          )}
        </Card>
      </div>
    </Shell>
  );
}
