'use client';

import { useActionState, useState } from 'react';
import {
  createKioskAction,
  revokeKioskAction,
  rotateKioskAction,
  updateKioskAction,
  type KioskFormState,
} from '@/app/actions/wall';
import { Alert, Badge, Button, Card, FieldShell, Input, Select, Textarea } from './ui';

export interface KioskView {
  id: number;
  name: string;
  tokenPrefix: string;
  allowedCidrs: string[];
  createdBy: string;
  createdAt: string;
  rotatedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  lastUsedAt: string | null;
  lastUsedIp: string | null;
}

function ShowOnce({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="mt-3 rounded-lg border border-emerald-500/40 bg-emerald-500/10 p-3">
      <div className="text-xs text-emerald-200">Wall URL (shown once)</div>
      <div className="mt-1 flex gap-2">
        <code
          className="min-w-0 flex-1 break-all rounded bg-slate-950/70 px-2 py-1.5 font-mono text-xs text-slate-100"
          data-testid="wall-url"
        >
          {url}
        </code>
        <Button
          type="button"
          variant="secondary"
          onClick={() => {
            void navigator.clipboard?.writeText(url).then(() => setCopied(true));
          }}
        >
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>
    </div>
  );
}

function KioskFields({
  state,
  initial,
  editing,
}: {
  state: KioskFormState;
  initial?: KioskView;
  editing?: boolean;
}) {
  const e = state.errors ?? {};
  const v = state.values;
  const prefix = initial ? `k${initial.id}` : 'knew';
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <FieldShell id={`${prefix}-name`} label="Screen name" error={e.name}>
        <Input
          id={`${prefix}-name`}
          name="name"
          defaultValue={v?.name ?? initial?.name ?? ''}
          placeholder="NOC TV, IT office"
          maxLength={80}
        />
      </FieldShell>
      <FieldShell id={`${prefix}-exp`} label="Expires">
        <Select
          id={`${prefix}-exp`}
          name="expiresDays"
          defaultValue={v?.expiresDays ?? (editing ? 'keep' : '')}
        >
          {editing && (
            <option value="keep">
              Keep (
              {initial?.expiresAt ? new Date(initial.expiresAt).toLocaleDateString() : 'never'})
            </option>
          )}
          <option value="">Never</option>
          <option value="30">In 30 days</option>
          <option value="90">In 90 days</option>
          <option value="365">In a year</option>
        </Select>
      </FieldShell>
      <div className="sm:col-span-2">
        <FieldShell
          id={`${prefix}-cidrs`}
          label="Allowed addresses (optional)"
          error={e.cidrs}
          help="IP addresses or ranges, one per line, e.g. 10.20.0.0/24. Empty allows any address."
        >
          <Textarea
            id={`${prefix}-cidrs`}
            name="cidrs"
            rows={2}
            defaultValue={v?.cidrs ?? initial?.allowedCidrs.join('\n') ?? ''}
            placeholder="10.20.0.0/24"
          />
        </FieldShell>
      </div>
    </div>
  );
}

function CreateForm() {
  const [state, action, pending] = useActionState<KioskFormState, FormData>(createKioskAction, {});
  return (
    <form action={action} className="space-y-4" aria-label="New wall link">
      <KioskFields state={state} key={state.url ?? 'form'} />
      <Button type="submit" disabled={pending}>
        {pending ? 'Creating…' : 'Create wall link'}
      </Button>
      {state.message && <Alert tone={state.ok ? 'success' : 'error'}>{state.message}</Alert>}
      {state.url && <ShowOnce url={state.url} />}
    </form>
  );
}

function TokenRow({ t, tz }: { t: KioskView; tz: string }) {
  const [edit, editAction, editing] = useActionState<KioskFormState, FormData>(
    updateKioskAction.bind(null, t.id),
    {},
  );
  const [rot, rotAction, rotating] = useActionState<KioskFormState, FormData>(
    rotateKioskAction.bind(null, t.id),
    {},
  );
  const expired = !!t.expiresAt && new Date(t.expiresAt).getTime() < Date.now();
  const live = !t.revokedAt && !expired;
  const when = (iso: string | null) =>
    iso
      ? new Date(iso).toLocaleString('en-US', {
          timeZone: tz,
          dateStyle: 'medium',
          timeStyle: 'short',
        })
      : '—';
  return (
    <li className="py-4" data-testid={`kiosk-${t.name}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium text-slate-100">{t.name}</span>
        <code className="text-xs text-slate-500">/wall/{t.tokenPrefix}…</code>
        {t.revokedAt ? (
          <Badge tone="bad">revoked</Badge>
        ) : expired ? (
          <Badge tone="warn">expired</Badge>
        ) : (
          <Badge tone="ok">active</Badge>
        )}
        {t.allowedCidrs.length > 0 ? (
          <Badge tone="info">{t.allowedCidrs.join(', ')}</Badge>
        ) : (
          live && <Badge tone="warn">any address</Badge>
        )}
      </div>
      <div className="mt-1 text-xs text-slate-400">
        Created by {t.createdBy} {when(t.createdAt)}
        {t.rotatedAt && ` · rotated ${when(t.rotatedAt)}`}
        {t.expiresAt && ` · expires ${when(t.expiresAt)}`} · last used {when(t.lastUsedAt)}
        {t.lastUsedIp && ` from ${t.lastUsedIp}`}
      </div>
      {live && (
        <div className="mt-3 flex flex-wrap gap-2">
          <details className="w-full rounded-lg border border-white/10 p-3 open:bg-white/[0.02]">
            <summary className="cursor-pointer text-sm text-slate-300">Edit</summary>
            <form action={editAction} className="mt-3 space-y-3">
              <KioskFields state={edit} initial={t} editing />
              <Button type="submit" variant="secondary" disabled={editing}>
                Save
              </Button>
              {edit.message && <Alert tone={edit.ok ? 'success' : 'error'}>{edit.message}</Alert>}
            </form>
          </details>
          <form action={rotAction}>
            <Button
              type="submit"
              variant="secondary"
              disabled={rotating}
              onClick={(e) => {
                if (
                  !window.confirm(
                    `Replace the link for “${t.name}”? The current URL stops working at once.`,
                  )
                )
                  e.preventDefault();
              }}
            >
              Rotate link
            </Button>
          </form>
          <form action={revokeKioskAction}>
            <input type="hidden" name="id" value={t.id} />
            <Button
              type="submit"
              variant="danger"
              onClick={(e) => {
                if (!window.confirm(`Revoke “${t.name}”? That screen goes blank at once.`))
                  e.preventDefault();
              }}
            >
              Revoke
            </Button>
          </form>
        </div>
      )}
      {rot.message && (
        <div className="mt-3">
          <Alert tone={rot.ok ? 'success' : 'error'}>{rot.message}</Alert>
        </div>
      )}
      {rot.url && <ShowOnce url={rot.url} />}
    </li>
  );
}

export function KioskPanel({
  tokens,
  tz,
  yourIp,
}: {
  tokens: KioskView[];
  tz: string;
  yourIp: string | null;
}) {
  return (
    <div className="space-y-6">
      <Card
        title="New wall link"
        description="Each NOC screen gets its own link with a long random token. Open it in the screen's browser in full-screen/kiosk mode; no sign-in needed."
      >
        <p className="mb-4 text-xs text-slate-400">
          Your address as MAS sees it: <code className="text-slate-200">{yourIp ?? 'unknown'}</code>
          {yourIp === null &&
            ' (set up the reverse-proxy setting under General if MAS is behind a proxy).'}
        </p>
        <CreateForm />
      </Card>
      <Card title={`Wall links (${tokens.length})`}>
        {tokens.length === 0 ? (
          <p className="text-sm text-slate-400">None yet.</p>
        ) : (
          <ul className="divide-y divide-white/10">
            {tokens.map((t) => (
              <TokenRow key={t.id} t={t} tz={tz} />
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
