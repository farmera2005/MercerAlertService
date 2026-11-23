import { SETTING_SECTIONS } from '@mercer/core';
import { listChannels, listNotifierHealth } from '@mercer/db';
import { ChannelsPanel } from '@/components/notify/channels-panel';
import { SettingsForm } from '@/components/settings-form';
import { Alert, Card } from '@/components/ui';
import { server } from '@/lib/server';
import { getSettingsState, sectionFields } from '@/lib/settings';

export const dynamic = 'force-dynamic';

export default async function NotificationSettings() {
  const state = await getSettingsState();
  const cfg = state.cfg ?? server().bootstrap;
  const { db } = server();
  const [channels, health] = await Promise.all([listChannels(db.db), listNotifierHealth(db.db)]);
  const byKey = new Map(health.map((h) => [h.key, h]));
  const provider = (key: string) => byKey.get(key);
  return (
    <div className="space-y-6">
      {cfg.notify.shadow.enabled ? (
        <Alert tone="info" title="Shadow mode is on">
          Every message goes to #{cfg.notify.shadow.channelKey} marked [SHADOW], showing where it
          would have gone and who would have been paged. Nobody is paged
          {cfg.notify.shadow.allowPaging ? ' (except that paging is allowed in shadow mode)' : ''}.
          Turn shadow mode off below to go live.
        </Alert>
      ) : (
        <Alert tone="success" title="Live">
          Notifications go to the channels and people chosen by the routing rules.
        </Alert>
      )}
      <Card
        title="Teams channels"
        description="Each channel is a Teams Workflows webhook. The URL acts as a password: it is stored encrypted and never shown again."
      >
        <ChannelsPanel
          shadowKey={cfg.notify.shadow.channelKey}
          shadowOn={cfg.notify.shadow.enabled}
          channels={channels.map((c) => {
            const h = byKey.get(`teams:${c.key}`);
            return {
              key: c.key,
              name: c.name,
              description: c.description,
              enabled: c.enabled,
              configured: c.configured,
              health: h
                ? {
                    failures: h.consecutiveFailures,
                    lastError: h.lastError,
                    lastSuccessAt: h.lastSuccessAt?.toISOString() ?? null,
                  }
                : null,
            };
          })}
        />
      </Card>
      {(['twilio', 'pushover'] as const).map((k) => {
        const h = provider(k);
        return h && h.consecutiveFailures > 0 ? (
          <Alert
            key={k}
            tone="error"
            title={`${k === 'twilio' ? 'Twilio' : 'Pushover'} is failing`}
          >
            {h.consecutiveFailures} failure(s) in a row. Last error: {h.lastError}
          </Alert>
        ) : null;
      })}
      <SettingsForm
        sections={(['notify', 'paging', 'twilio', 'pushover'] as const).map((section) => ({
          section,
          title: SETTING_SECTIONS[section].title,
          description: SETTING_SECTIONS[section].description,
          fields: sectionFields(section, state),
        }))}
        submitLabel="Save notification settings"
      />
      <Card
        title="Creating a Teams webhook (Workflows)"
        description="About two minutes per channel, in the Teams app."
        className="[&_b]:text-slate-100"
      >
        <ol
          className="list-decimal space-y-2 pl-5 text-sm text-slate-300"
          data-testid="teams-steps"
        >
          <li>
            In Teams, point at the channel’s name in the list on the left (a <b>standard</b>{' '}
            channel: workflows can’t post to private channels), select <b>⋯ More options</b> →{' '}
            <b>Workflows</b>. If there is no Workflows entry, open the <b>Workflows</b> app from the
            Teams apps bar instead and choose <b>Create</b>.
          </li>
          <li>
            Search for the template <b>Send webhook alerts to a channel</b> and select it.
          </li>
          <li>
            Name it, e.g. “MAS net-critical”. Make sure the Microsoft Teams connection has a green
            tick (sign in if asked), then select <b>Next</b>.
          </li>
          <li>
            Choose the <b>Team</b> and <b>Channel</b>, then <b>Add workflow</b> (some versions say{' '}
            <b>Save</b>).
          </li>
          <li>
            Copy the URL on the confirmation screen. It looks like{' '}
            <code className="text-slate-200">
              https://…environment.api.powerplatform.com/powerautomate/…
            </code>
            . Paste it into the channel above, save, and click <b>Send test</b>.
          </li>
        </ol>
        <ul className="mt-4 list-disc space-y-1.5 pl-5 text-xs text-slate-400">
          <li>
            <b>Copy the URL again later:</b> Workflows app → the workflow → <b>Edit</b> → expand
            “When a Teams webhook request is received” → copy the URL.
          </li>
          <li>
            <b>Keep “Who can trigger the flow?” set to Anyone</b> (the template’s setting) in that
            same step. MAS can’t sign in to Microsoft, so a test failing with HTTP 401 or 403 means
            it was changed. The URL is the secret: MAS stores it encrypted.
          </li>
          <li>
            <b>Old URLs:</b> addresses on <code>logic.azure.com</code> stopped working after 30
            November 2025. Copy the workflow’s current URL as above and paste it again.
          </li>
          <li>
            <b>Ownership:</b> a workflow belongs to the person who created it and stops when their
            account is disabled. Create them with a shared IT account, or add a second owner in
            Power Automate (make.powerautomate.com → My flows → the workflow → Share).
          </li>
          <li>
            <b>No Workflows app?</b> A Teams administrator must allow it (Teams admin center → Teams
            apps → Manage apps → Workflows). It uses only standard connectors, so a normal Microsoft
            365 licence is enough.
          </li>
        </ul>
        <p className="mt-3 text-xs text-slate-400">
          These replace the Office 365 “Incoming Webhook” connector, which Microsoft retired. Test
          sends always go to the chosen channel, even in shadow mode.
        </p>
      </Card>
    </div>
  );
}
