import { SETTING_SECTIONS } from '@mercer/core';
import { ASSET_KEYS, getSettingAssetInfo, listKioskTokens } from '@mercer/db';
import { KioskPanel } from '@/components/kiosk-panel';
import { MapImageForm } from '@/components/map-image-form';
import { SettingsForm } from '@/components/settings-form';
import { Card } from '@/components/ui';
import { listBoardViews } from '@/lib/noc';
import { requestMeta } from '@/lib/request';
import { server } from '@/lib/server';
import { getSettingsState, sectionFields } from '@/lib/settings';

export const dynamic = 'force-dynamic';

export default async function WallSettings() {
  const state = await getSettingsState();
  const cfg = state.cfg ?? server().bootstrap;
  const { db } = server();
  const [tokens, image, meta, boards] = await Promise.all([
    listKioskTokens(db.db),
    getSettingAssetInfo(db.db, ASSET_KEYS.mapImage),
    requestMeta(),
    listBoardViews(),
  ]);
  return (
    <div className="space-y-6">
      <KioskPanel
        tz={cfg.timezone}
        yourIp={meta.ip}
        tokens={tokens.map((t) => ({
          id: t.id,
          name: t.name,
          tokenPrefix: t.tokenPrefix,
          allowedCidrs: t.allowedCidrs,
          createdBy: t.createdBy,
          createdAt: t.createdAt.toISOString(),
          rotatedAt: t.rotatedAt?.toISOString() ?? null,
          expiresAt: t.expiresAt?.toISOString() ?? null,
          revokedAt: t.revokedAt?.toISOString() ?? null,
          lastUsedAt: t.lastUsedAt?.toISOString() ?? null,
          lastUsedIp: t.lastUsedIp,
          boards: t.boards,
          boardRotateSec: t.boardRotateSec,
        }))}
        boards={boards.map((b) => ({ ref: b.ref, name: b.name }))}
      />
      <SettingsForm
        sections={(['wall', 'map'] as const).map((section) => ({
          section,
          title: SETTING_SECTIONS[section].title,
          description: SETTING_SECTIONS[section].description,
          fields: sectionFields(section, state),
        }))}
        submitLabel="Save map & wall settings"
      />
      <Card
        title="Offline map image"
        description="For servers without internet access: upload a map (PNG, JPEG or WebP, up to 5 MB), choose “Offline image” above, then set each site's Map X/Y in Settings → Sites."
      >
        <MapImageForm
          current={
            image
              ? {
                  width: image.width,
                  height: image.height,
                  updatedAt: image.updatedAt.toISOString(),
                  url: `/api/map-image?v=${image.sha256.slice(0, 12)}`,
                }
              : null
          }
        />
      </Card>
    </div>
  );
}
