import Link from 'next/link';
import { SETTING_SECTIONS } from '@mercer/core';
import { listChannels } from '@mercer/db';
import { DigestNowForm } from '@/components/ai-panels';
import { SettingsForm } from '@/components/settings-form';
import { Alert, Card } from '@/components/ui';
import { server } from '@/lib/server';
import { getSettingsState, sectionFields } from '@/lib/settings';

export const dynamic = 'force-dynamic';

export default async function DigestSettings() {
  const state = await getSettingsState();
  const cfg = state.cfg ?? server().bootstrap;
  const channels = await listChannels(server().db.db);
  const target = cfg.notify.shadow.enabled ? cfg.notify.shadow.channelKey : cfg.digest.channelKey;
  const channel = channels.find((c) => c.key === target);
  return (
    <div className="space-y-6">
      {!channel?.configured ? (
        <Alert tone="warning" title={`#${target} has no webhook yet`}>
          Digests are still written and kept in the{' '}
          <Link className="underline" href="/digests">
            digest archive
          </Link>
          , but they are not posted until the channel has a webhook (Settings →{' '}
          <Link className="underline" href="/settings/notifications">
            Notifications
          </Link>
          ).
        </Alert>
      ) : (
        <Alert tone="info" title={`Digests post to #${target}`}>
          {cfg.notify.shadow.enabled
            ? `Shadow mode is on, so they go to the shadow channel instead of #${cfg.digest.channelKey}.`
            : 'Each one is also kept in the digest archive.'}
          {!cfg.ai.enabled && ' AI is off, so they are written from the template.'}
        </Alert>
      )}
      <Card
        title="Send now"
        description="Writes and posts a digest for the period up to now, like the scheduled one."
      >
        <div className="flex flex-wrap gap-6">
          <DigestNowForm kind="daily" />
          <DigestNowForm kind="weekly" />
        </div>
      </Card>
      <SettingsForm
        sections={[
          {
            section: 'digest',
            title: SETTING_SECTIONS.digest.title,
            description: SETTING_SECTIONS.digest.description,
            fields: sectionFields('digest', state),
          },
        ]}
        submitLabel="Save digest settings"
      />
    </div>
  );
}
