'use client';

import { deleteChannelAction, saveChannelAction, testSendAction } from '@/app/actions/notify';
import { StatefulForm } from '../stateful-form';
import { Badge, Button, FieldShell, Input } from '../ui';

export interface ChannelView {
  key: string;
  name: string;
  description: string | null;
  enabled: boolean;
  configured: boolean;
  health: { failures: number; lastError: string | null; lastSuccessAt: string | null } | null;
}

function ChannelFields({ c, errors }: { c?: ChannelView; errors: Record<string, string> }) {
  const id = c ? `ch-${c.key}` : 'ch-new';
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {c ? (
        <input type="hidden" name="key" value={c.key} />
      ) : (
        <FieldShell
          id={`${id}-key`}
          label="Key"
          error={errors.key}
          help="Used in routing rules, e.g. net-critical"
        >
          <Input id={`${id}-key`} name="key" placeholder="net-critical" />
        </FieldShell>
      )}
      <FieldShell id={`${id}-name`} label="Name" error={errors.name}>
        <Input
          id={`${id}-name`}
          name="name"
          defaultValue={c?.name ?? ''}
          placeholder="IT Network Alerts › net-critical"
        />
      </FieldShell>
      <FieldShell id={`${id}-desc`} label="Description" error={errors.description}>
        <Input id={`${id}-desc`} name="description" defaultValue={c?.description ?? ''} />
      </FieldShell>
      <div className="sm:col-span-2">
        <FieldShell
          id={`${id}-url`}
          label="Workflows webhook URL"
          error={errors.webhookUrl}
          help={
            c?.configured
              ? 'A URL is saved (it is never shown again). Paste a new one to replace it.'
              : 'The URL the Teams workflow “Send webhook alerts to a channel” shows (…environment.api.powerplatform.com/…). Steps below.'
          }
        >
          <Input
            id={`${id}-url`}
            name="webhookUrl"
            type="password"
            autoComplete="off"
            placeholder={
              c?.configured ? '•••••••• (saved)' : 'https://…environment.api.powerplatform.com/…'
            }
          />
        </FieldShell>
      </div>
      <label className="flex items-center gap-2 text-sm text-slate-200">
        <input
          type="checkbox"
          name="enabled"
          defaultChecked={c?.enabled ?? true}
          className="accent-sky-400"
        />
        Enabled
      </label>
      {c?.configured && (
        <label className="flex items-center gap-2 text-sm text-slate-300">
          <input type="checkbox" name="removeWebhook" className="accent-red-400" />
          Remove the saved URL
        </label>
      )}
    </div>
  );
}

export function ChannelsPanel({
  channels,
  shadowKey,
  shadowOn,
}: {
  channels: ChannelView[];
  shadowKey: string;
  shadowOn: boolean;
}) {
  return (
    <div className="space-y-4">
      <ul
        className="divide-y divide-white/10 rounded-xl border border-white/10"
        data-testid="channels"
      >
        {channels.map((c) => (
          <li key={c.key} className="p-4" data-testid={`channel-${c.key}`}>
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium text-slate-100">#{c.key}</span>
              <span className="text-sm text-slate-400">{c.name}</span>
              {c.configured ? (
                <Badge tone="ok">webhook set</Badge>
              ) : (
                <Badge tone="warn">no webhook</Badge>
              )}
              {!c.enabled && <Badge>disabled</Badge>}
              {c.key === shadowKey && (
                <Badge tone={shadowOn ? 'info' : 'neutral'}>shadow channel</Badge>
              )}
              {c.health && c.health.failures > 0 && (
                <Badge tone="bad">
                  {c.health.failures} failure{c.health.failures === 1 ? '' : 's'}
                </Badge>
              )}
            </div>
            {c.description && <p className="mt-1 text-xs text-slate-400">{c.description}</p>}
            {c.health?.lastError && c.health.failures > 0 && (
              <p className="mt-1 text-xs text-red-300">Last error: {c.health.lastError}</p>
            )}
            <div className="mt-3 flex flex-wrap items-start gap-3">
              <StatefulForm action={testSendAction} label={`Test #${c.key}`}>
                {(_, pending) => (
                  <>
                    <input type="hidden" name="kind" value="teams" />
                    <input type="hidden" name="channelKey" value={c.key} />
                    <Button type="submit" variant="secondary" disabled={pending}>
                      {pending ? 'Sending…' : 'Send test'}
                    </Button>
                  </>
                )}
              </StatefulForm>
              <details className="min-w-[280px] flex-1 rounded-lg border border-white/10 p-3 open:bg-white/[0.02]">
                <summary className="cursor-pointer text-sm text-slate-300">Edit</summary>
                <div className="mt-3">
                  <StatefulForm action={saveChannelAction} label={`Edit #${c.key}`}>
                    {(state, pending) => (
                      <div className="space-y-4">
                        <ChannelFields c={c} errors={state.errors ?? {}} />
                        <Button type="submit" disabled={pending}>
                          Save
                        </Button>
                      </div>
                    )}
                  </StatefulForm>
                  <form action={deleteChannelAction} className="mt-3">
                    <input type="hidden" name="key" value={c.key} />
                    <Button
                      type="submit"
                      variant="ghost"
                      onClick={(e) => {
                        if (
                          !window.confirm(
                            `Delete #${c.key}? Rules that post to it will stop posting.`,
                          )
                        )
                          e.preventDefault();
                      }}
                    >
                      Delete channel
                    </Button>
                  </form>
                </div>
              </details>
            </div>
          </li>
        ))}
      </ul>
      <details className="rounded-xl border border-white/10 p-4 open:bg-white/[0.02]">
        <summary className="cursor-pointer text-sm font-medium text-slate-200">
          Add a channel
        </summary>
        <div className="mt-4">
          <StatefulForm action={saveChannelAction} label="Add a channel" resetOnSuccess>
            {(state, pending) => (
              <div className="space-y-4">
                <ChannelFields errors={state.errors ?? {}} />
                <Button type="submit" disabled={pending}>
                  Add channel
                </Button>
              </div>
            )}
          </StatefulForm>
        </div>
      </details>
    </div>
  );
}
