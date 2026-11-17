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
      <Card title="Creating a Teams Workflows webhook" description="About two minutes per channel.">
        <ol className="list-decimal space-y-1.5 pl-5 text-sm text-slate-300">
          <li>
            In Teams, open the channel → <b>…</b> → <b>Workflows</b> → “Post to a channel when a
            webhook request is received”.
          </li>
          <li>Name it “MAS”, pick the team and channel, and create it.</li>
          <li>
            Copy the URL it shows and paste it into the channel above, then click <b>Send test</b>.
          </li>
        </ol>
        <p className="mt-3 text-xs text-slate-400">
          These are Teams Workflows (Power Automate) webhooks, not the retired Office 365
          connectors. Test sends always go to the chosen channel, even in shadow mode.
        </p>
      </Card>
    </div>
  );
}
