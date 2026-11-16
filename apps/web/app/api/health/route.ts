import { NextResponse } from 'next/server';
import { getHealth } from '@/lib/health';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const liveness = new URL(req.url).searchParams.has('liveness');
  const { httpStatus, report } = await getHealth({ liveness });
  return NextResponse.json(report, {
    status: httpStatus,
    headers: { 'cache-control': 'no-store' },
  });
}
