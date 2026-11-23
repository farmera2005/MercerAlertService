'use client';

import {
  createLocalAccountAction,
  resetLocalPasswordAction,
  saveDeviceOverrideAction,
  resetTwoFactorAction,
  setLocalAccountDisabledAction,
} from '@/app/actions/admin';
import { StatefulForm } from './stateful-form';
import { Badge, Button, FieldShell, Input, Select } from './ui';

export interface DeviceOverrideView {
  nodeId: number;
  siteId: number | null;
  role: string | null;
  reason: string | null;
}

export function DeviceOverrideForm({
  o,
  sites,
  roles,
}: {
  o: DeviceOverrideView;
  sites: Array<{ id: number; name: string }>;
  roles: Array<{ value: string; label: string }>;
}) {
  const id = `ov-${o.nodeId}`;
  return (
    <StatefulForm
      action={saveDeviceOverrideAction.bind(null, o.nodeId)}
      label={`Override for node ${o.nodeId}`}
    >
      {(state, pending) => (
        <div className="grid gap-3 sm:grid-cols-[1fr_1fr_1.4fr_auto] sm:items-end">
          <FieldShell id={`${id}-site`} label="Site" error={state.errors?.siteId}>
            <Select id={`${id}-site`} name="siteId" defaultValue={o.siteId ?? ''}>
              <option value="">From Orion properties</option>
              {sites.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </Select>
          </FieldShell>
          <FieldShell id={`${id}-role`} label="Role" error={state.errors?.role}>
            <Select id={`${id}-role`} name="role" defaultValue={o.role ?? ''}>
              <option value="">Detected automatically</option>
              {roles.map((r) => (
                <option key={r.value} value={r.value}>
                  {r.label}
                </option>
              ))}
            </Select>
          </FieldShell>
          <FieldShell id={`${id}-reason`} label="Why (optional)">
            <Input
              id={`${id}-reason`}
              name="reason"
              defaultValue={o.reason ?? ''}
              placeholder="Site property is blank in Orion"
              maxLength={300}
            />
          </FieldShell>
          <Button type="submit" variant="secondary" disabled={pending}>
            Save
          </Button>
        </div>
      )}
    </StatefulForm>
  );
}

export interface LocalAccountView {
  id: number;
  username: string;
  lastLogin: string;
  disabled: boolean;
  isYou: boolean;
  /** What second steps it has ("app + 1 passkey"), or null. */
  twoFactor: string | null;
  hasTwoFactor: boolean;
}

function PasswordFields({ prefix, errors }: { prefix: string; errors: Record<string, string> }) {
  return (
    <>
      <FieldShell id={`${prefix}-pw`} label="New password" error={errors.password}>
        <Input
          id={`${prefix}-pw`}
          name="password"
          type="password"
          autoComplete="new-password"
          minLength={12}
        />
      </FieldShell>
      <FieldShell id={`${prefix}-confirm`} label="Repeat it" error={errors.confirm}>
        <Input
          id={`${prefix}-confirm`}
          name="confirm"
          type="password"
          autoComplete="new-password"
        />
      </FieldShell>
    </>
  );
}

export function LocalAccountsPanel({ accounts }: { accounts: LocalAccountView[] }) {
  return (
    <div className="space-y-4">
      <ul
        className="divide-y divide-white/10 rounded-xl border border-white/10"
        data-testid="local-accounts"
      >
        {accounts.map((a) => (
          <li key={a.id} className="space-y-3 p-4">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium text-slate-100">{a.username}</span>
              {a.isYou && <Badge tone="info">you</Badge>}
              {a.disabled && <Badge tone="bad">disabled</Badge>}
              {a.twoFactor ? (
                <Badge tone="ok">two-step: {a.twoFactor}</Badge>
              ) : (
                <Badge tone="warn">no two-step sign-in</Badge>
              )}
              <span className="text-sm text-slate-400">last sign-in {a.lastLogin}</span>
            </div>
            <div className="flex flex-wrap items-start gap-3">
              <details className="min-w-[280px] flex-1 rounded-lg border border-white/10 p-3 open:bg-white/[0.02]">
                <summary className="cursor-pointer text-sm text-slate-300">Change password</summary>
                <div className="mt-3">
                  <StatefulForm
                    action={resetLocalPasswordAction.bind(null, a.id)}
                    label={`Change password for ${a.username}`}
                    resetOnSuccess
                  >
                    {(state, pending) => (
                      <div className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
                        <PasswordFields prefix={`la-${a.id}`} errors={state.errors ?? {}} />
                        <Button type="submit" variant="secondary" disabled={pending}>
                          Change
                        </Button>
                      </div>
                    )}
                  </StatefulForm>
                </div>
              </details>
              {!a.isYou && (
                <StatefulForm
                  action={resetTwoFactorAction}
                  label={`Reset two-step sign-in for ${a.username}`}
                >
                  {(_, pending) => (
                    <>
                      <input type="hidden" name="id" value={a.id} />
                      <Button
                        type="submit"
                        variant="ghost"
                        disabled={pending || !a.hasTwoFactor}
                        title="For a lost phone or key: removes the authenticator app, passkeys and recovery codes"
                      >
                        Reset two-step sign-in
                      </Button>
                    </>
                  )}
                </StatefulForm>
              )}
              {!a.isYou && (
                <StatefulForm
                  action={setLocalAccountDisabledAction}
                  label={`${a.disabled ? 'Enable' : 'Disable'} ${a.username}`}
                >
                  {(_, pending) => (
                    <>
                      <input type="hidden" name="id" value={a.id} />
                      <input type="hidden" name="disable" value={String(!a.disabled)} />
                      <Button type="submit" variant="ghost" disabled={pending}>
                        {a.disabled ? 'Enable' : 'Disable'}
                      </Button>
                    </>
                  )}
                </StatefulForm>
              )}
            </div>
          </li>
        ))}
      </ul>
      <details className="rounded-xl border border-white/10 p-4 open:bg-white/[0.02]">
        <summary className="cursor-pointer text-sm font-medium text-slate-200">
          Add a local administrator
        </summary>
        <div className="mt-4">
          <StatefulForm
            action={createLocalAccountAction}
            label="Add a local administrator"
            resetOnSuccess
          >
            {(state, pending) => (
              <div className="grid gap-3 sm:grid-cols-[1fr_1fr_1fr_auto] sm:items-end">
                <FieldShell id="la-new-user" label="Username" error={state.errors?.username}>
                  <Input id="la-new-user" name="username" autoComplete="off" />
                </FieldShell>
                <PasswordFields prefix="la-new" errors={state.errors ?? {}} />
                <Button type="submit" disabled={pending}>
                  Add
                </Button>
              </div>
            )}
          </StatefulForm>
        </div>
      </details>
    </div>
  );
}
