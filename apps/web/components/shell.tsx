import Link from 'next/link';
import type { ReactNode } from 'react';
import { listHeartbeats, listPollerStates } from '@mercer/db';
import { logoutAction } from '@/app/actions/auth';
import type { CurrentUser } from '@/lib/auth';
import { liveInitial } from '@/lib/live-initial';
import { server } from '@/lib/server';
import { cachedSettingsState } from '@/lib/settings';
import { LiveDot, LiveProvider, StaleBanner } from './live';
import { NavLinks } from './nav-links';

interface Banner {
  tone: 'error' | 'warning';
  text: ReactNode;
}

/** Problems the live stream cannot show (they are about configuration, not freshness). */
async function systemBanners(user: CurrentUser): Promise<Banner[]> {
  const out: Banner[] = [];
  const state = await cachedSettingsState();
  if (state.configError && user.isAdmin)
    out.push({
      tone: 'error',
      text: (
        <>
          Saved settings are invalid; the worker keeps the last good configuration.{' '}
          <Link className="underline" href="/settings/general">
            Fix in Settings
          </Link>
        </>
      ),
    });
  const [beats, pollers] = await Promise.all([
    listHeartbeats(server().db.db),
    listPollerStates(server().db.db),
  ]);
  const swis = beats.find((b) => b.component === 'swis');
  if ((swis?.details as { tlsVerification?: string } | undefined)?.tlsVerification === 'DISABLED')
    out.push({
      tone: 'error',
      text: 'TLS verification to SolarWinds is DISABLED (development flag). Do not run like this in production.',
    });
  for (const p of pollers)
    if (p.consecutiveFailures >= 3)
      out.push({
        tone: 'warning',
        text: `The ${p.poller} poller has failed ${p.consecutiveFailures} times in a row${p.lastError ? `: ${p.lastError.slice(0, 160)}` : ''}.`,
      });
  return out;
}

export async function Shell({
  children,
  user,
  wide,
}: {
  children: ReactNode;
  user: CurrentUser;
  wide?: boolean;
}) {
  const [initial, banners] = await Promise.all([liveInitial(), systemBanners(user)]);
  const width = wide ? 'max-w-7xl' : 'max-w-4xl';
  return (
    <LiveProvider endpoint="/api/events" initial={initial}>
      <div className="min-h-screen">
        <StaleBanner />
        <header className="border-b border-white/10 bg-slate-950/60">
          <div className={`mx-auto flex flex-wrap items-center gap-x-6 gap-y-2 px-6 py-3 ${width}`}>
            <Link href="/" className="font-semibold tracking-tight text-slate-100">
              Mercer Landmark · Network Status
            </Link>
            <NavLinks isAdmin={user.isAdmin} />
            <div className="ml-auto flex items-center gap-4 text-sm text-slate-400">
              <LiveDot />
              <span title={user.label}>{user.username}</span>
              <form action={logoutAction}>
                <button type="submit" className="hover:text-white">
                  Sign out
                </button>
              </form>
            </div>
          </div>
        </header>
        {banners.map((b, i) => (
          <div
            key={i}
            role={b.tone === 'error' ? 'alert' : 'status'}
            className={`border-b px-6 py-2 text-sm ${b.tone === 'error' ? 'border-red-500/40 bg-red-500/15 text-red-100' : 'border-amber-500/40 bg-amber-500/10 text-amber-100'}`}
          >
            <div className={`mx-auto ${width}`}>{b.text}</div>
          </div>
        ))}
        <main className={`mx-auto px-6 py-8 ${width}`}>{children}</main>
      </div>
    </LiveProvider>
  );
}
