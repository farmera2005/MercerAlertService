import type { NextRequest } from 'next/server';
import { ASSET_KEYS, getSettingAsset } from '@mercer/db';
import { currentUser } from '@/lib/auth';
import { checkKioskToken } from '@/lib/kiosk';
import { server } from '@/lib/server';

export const dynamic = 'force-dynamic';

/** The offline map background (MAP_MODE=image), for signed-in users and wall links. */
export async function GET(req: NextRequest) {
  const kiosk = req.nextUrl.searchParams.get('k');
  const allowed = kiosk ? (await checkKioskToken(kiosk, req.headers)).ok : !!(await currentUser());
  if (!allowed) return new Response(null, { status: 403 });
  const asset = await getSettingAsset(server().db.db, ASSET_KEYS.mapImage);
  if (!asset) return new Response(null, { status: 404 });
  const etag = `"${asset.sha256}"`;
  if (req.headers.get('if-none-match') === etag) return new Response(null, { status: 304 });
  return new Response(new Uint8Array(asset.data), {
    headers: {
      'Content-Type': asset.contentType,
      'Cache-Control': 'private, max-age=300',
      ETag: etag,
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
