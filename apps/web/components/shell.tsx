import Link from 'next/link';
import type { ReactNode } from 'react';
import { budgetState, startOfZonedDay } from '@mercer/core';
import { aiSpendSince, listHeartbeats, listNotifierHealth, listPollerStates } from '@mercer/db';
import { logoutAction } from '@/app/actions/auth';
import type { CurrentUser } from '@/lib/auth';
import { liveInitial } from '@/lib/live-initial';
import { server } from '@/lib/server';
import { cachedSettingsState } from '@/lib/settings';
import { LiveDot, LiveProvider, StaleBanner } from './live';
import { NavLinks } from './nav-links';

interface Banner {
  tone: 'error' | 'warning' | 'info';
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
  const cfg = state.cfg ?? server().bootstrap;
  if (cfg.notify.shadow.enabled)
    out.push({
      tone: 'info',
      text: (
        <>
          Shadow mode: notifications go only to #{cfg.notify.shadow.channelKey} and nobody is paged.
          {user.isAdmin && (
            <>
              {' '}
              <Link className="underline" href="/settings/notifications">
                Notification settings
              </Link>
            </>
          )}
        </>
      ),
    });
  const [beats, pollers, notifiers, aiSpent] = await Promise.all([
    listHeartbeats(server().db.db),
    listPollerStates(server().db.db),
    listNotifierHealth(server().db.db),
    cfg.ai.enabled
      ? aiSpendSince(server().db.db, startOfZonedDay(new Date(), cfg.timezone))
      : Promise.resolve(0),
  ]);
  const budget = budgetState(aiSpent, cfg.ai.dailyBudgetUsd);
  if (cfg.ai.enabled && budget.level !== 'ok')
    out.push({
      tone: 'warning',
      text: (
        <>
          {budget.level === 'exhausted'
            ? `The daily AI budget is spent (US$${budget.spentUsd.toFixed(2)}): summaries and digests use templates until midnight. Notifications are not affected.`
            : `AI spend today is US$${budget.spentUsd.toFixed(2)} of US$${budget.budgetUsd.toFixed(2)} (${Math.round(budget.fraction * 100)} %). At 100 % MAS uses templates until midnight.`}
          {user.isAdmin && (
            <>
              {' '}
              <Link className="underline" href="/settings/ai">
                AI settings
              </Link>
            </>
          )}
        </>
      ),
    });
  for (const n of notifiers)
    if (
      n.consecutiveFailures >= 3 &&
      !['outbox', 'correlation-backlog'].includes(n.key) &&
      !n.key.startsWith('ai-') &&
      !n.key.startsWith('poller:')
    )
      out.push({
        tone: 'error',
        text: (
          <>
            Notifications via {n.key.replace('teams:', '#')} are failing ({n.consecutiveFailures} in
            a row{n.lastError ? `: ${n.lastError.slice(0, 140)}` : ''}).
            {user.isAdmin && (
              <>
                {' '}
                <Link className="underline" href="/settings/notifications">
                  Check the settings
                </Link>
              </>
            )}
          </>
        ),
      });
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
  full,
}: {
  children: ReactNode;
  user: CurrentUser;
  wide?: boolean;
  /** The whole window width (NOC boards). */
  full?: boolean;
}) {
  const [initial, banners] = await Promise.all([liveInitial(), systemBanners(user)]);
  const width = full ? 'max-w-none' : wide ? 'max-w-7xl' : 'max-w-4xl';
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
              {user.kind === 'local' ? (
                <Link href="/account/security" title={user.label} className="hover:text-white">
                  {user.username}
                </Link>
              ) : (
                <span title={user.label}>{user.username}</span>
              )}
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
            className={`border-b px-6 py-2 text-sm ${b.tone === 'error' ? 'border-red-500/40 bg-red-500/15 text-red-100' : b.tone === 'warning' ? 'border-amber-500/40 bg-amber-500/10 text-amber-100' : 'border-sky-500/30 bg-sky-500/10 text-sky-100'}`}
          >
            <div className={`mx-auto ${width}`}>{b.text}</div>
          </div>
        ))}
        <main className={`mx-auto px-6 py-8 ${width}`}>{children}</main>
      </div>
    </LiveProvider>
  );
}
