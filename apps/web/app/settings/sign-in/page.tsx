import { SETTING_SECTIONS } from '@mercer/core';
import { listLocalAccounts, listUsers } from '@mercer/db';
import { LocalAccountsPanel } from '@/components/admin-panels';
import { SettingsForm } from '@/components/settings-form';
import { Alert, Badge, Card } from '@/components/ui';
import { currentUser } from '@/lib/auth';
import { server } from '@/lib/server';
import { getSettingsState, sectionFields } from '@/lib/settings';
import { entraRedirectUri } from '@/lib/sso';

export const dynamic = 'force-dynamic';

export default async function SignInSettings() {
  const state = await getSettingsState();
  const cfg = state.cfg ?? server().bootstrap;
  const [users, locals, me] = await Promise.all([
    listUsers(server().db.db),
    listLocalAccounts(server().db.db),
    currentUser(),
  ]);
  const redirectUri = entraRedirectUri(cfg);
  return (
    <div className="space-y-6">
      {cfg.auth.entra ? (
        <Alert tone="success" title="Microsoft sign-in is on">
          The sign-in page offers “Sign in with Microsoft”. Local administrator accounts still work
          under “Local administrator sign-in”.
        </Alert>
      ) : (
        <Alert tone="info" title="Microsoft sign-in is off">
          Until it is set up, only local administrator accounts can sign in.
        </Alert>
      )}
      <Card
        title="Register MAS in Microsoft Entra ID"
        description="One-time setup in the Entra admin center (entra.microsoft.com), about 10 minutes."
      >
        <ol className="list-decimal space-y-2 pl-5 text-sm text-slate-300">
          <li>
            <b>App registrations → New registration.</b> Name it “MercerAlertService”, single
            tenant, platform <b>Web</b>, redirect URI:
            <code className="mt-1 block break-all rounded bg-slate-950/70 px-2 py-1 font-mono text-xs text-sky-200">
              {redirectUri}
            </code>
            <span className="text-xs text-slate-400">
              This comes from the dashboard address in Settings → General. Change that first if
              people reach MAS on a different URL.
            </span>
          </li>
          <li>
            Copy the <b>Application (client) ID</b> and <b>Directory (tenant) ID</b> from Overview
            into the fields below.
          </li>
          <li>
            <b>Certificates &amp; secrets → New client secret.</b> Paste its <b>Value</b> below, and
            note the expiry date (MAS sign-in stops working when it expires).
          </li>
          <li>
            <b>Token configuration → Add groups claim →</b> Security groups, and for the ID token
            choose <b>Group ID</b>. Then, under Enterprise applications → this app →{' '}
            <b>Properties</b>, set <b>Assignment required</b> to Yes, and under{' '}
            <b>Users and groups</b> add the allowed group (and the admin group).
          </li>
          <li>Paste the Object IDs of the allowed group and, optionally, the admin group below.</li>
        </ol>
      </Card>
      <SettingsForm
        sections={[
          {
            section: 'sso',
            title: SETTING_SECTIONS.sso.title,
            description: SETTING_SECTIONS.sso.description,
            fields: sectionFields('sso', state),
          },
        ]}
        submitLabel="Save sign-in settings"
      />
      <Card title="People who have signed in with Microsoft">
        {users.length === 0 ? (
          <p className="text-sm text-slate-400">Nobody yet.</p>
        ) : (
          <table className="w-full text-left text-sm">
            <thead className="text-slate-400">
              <tr>
                <th className="py-2">Name</th>
                <th>E-mail</th>
                <th>Role</th>
                <th>Last sign-in</th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id} className="border-t border-white/10">
                  <td className="py-2">{u.name}</td>
                  <td className="text-slate-300">{u.email}</td>
                  <td>
                    {u.disabledAt ? (
                      <Badge tone="bad">disabled</Badge>
                    ) : u.isAdmin ? (
                      <Badge tone="info">admin</Badge>
                    ) : (
                      <Badge>member</Badge>
                    )}
                  </td>
                  <td className="text-slate-400">
                    {u.lastLoginAt?.toLocaleString('en-US', { timeZone: cfg.timezone }) ?? '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      <Card
        title="Local administrator accounts"
        description="Break-glass sign-in that works without Microsoft. Keep at least one, with a long password stored safely."
      >
        <LocalAccountsPanel
          accounts={locals.map((a) => ({
            id: a.id,
            username: a.username,
            lastLogin:
              a.lastLoginAt?.toLocaleString('en-US', { timeZone: cfg.timezone }) ?? 'never',
            disabled: !!a.disabledAt,
            isYou: me?.kind === 'local' && me.id === a.id,
          }))}
        />
      </Card>
    </div>
  );
}
