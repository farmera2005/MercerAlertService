'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cx } from './ui';

export const SETUP_STEPS = [
  { slug: 'orion', label: 'SolarWinds' },
  { slug: 'mapping', label: 'Mapping' },
  { slug: 'sites', label: 'Sites' },
  { slug: 'general', label: 'General' },
  { slug: 'finish', label: 'Finish' },
] as const;

function current(pathname: string) {
  return SETUP_STEPS.findIndex((s) => pathname.startsWith(`/setup/${s.slug}`));
}

export function Stepper() {
  const idx = current(usePathname());
  return (
    <ol className="flex flex-wrap gap-2 text-sm" aria-label="Setup steps">
      <li className="rounded-full bg-emerald-500/15 px-3 py-1 text-emerald-300">✓ Admin account</li>
      {SETUP_STEPS.map((s, i) => (
        <li key={s.slug}>
          <Link
            href={`/setup/${s.slug}`}
            aria-current={i === idx ? 'step' : undefined}
            className={cx(
              'block rounded-full px-3 py-1',
              i === idx
                ? 'bg-sky-500 text-slate-950'
                : i < idx
                  ? 'bg-white/10 text-slate-200'
                  : 'bg-white/5 text-slate-400',
            )}
          >
            {i + 1}. {s.label}
          </Link>
        </li>
      ))}
    </ol>
  );
}

export function StepFooter() {
  const idx = current(usePathname());
  if (idx < 0) return null;
  const prev = SETUP_STEPS[idx - 1];
  const next = SETUP_STEPS[idx + 1];
  return (
    <div className="mt-10 flex items-center justify-between border-t border-white/10 pt-6">
      {prev ? (
        <Link href={`/setup/${prev.slug}`} className="text-sm text-slate-300 hover:text-white">
          ← {prev.label}
        </Link>
      ) : (
        <span />
      )}
      {next && (
        <Link
          href={`/setup/${next.slug}`}
          className="rounded-md bg-white/10 px-4 py-2 text-sm font-medium hover:bg-white/15"
        >
          Next: {next.label} →
        </Link>
      )}
    </div>
  );
}

export const SETTINGS_TABS = [
  { href: '/settings/overview', label: 'Overview' },
  { href: '/settings/orion', label: 'SolarWinds' },
  { href: '/settings/mapping', label: 'Mapping' },
  { href: '/settings/sites', label: 'Sites' },
  { href: '/settings/devices', label: 'Devices' },
  { href: '/settings/correlation', label: 'Correlation & priority' },
  { href: '/settings/seasons', label: 'Seasons' },
  { href: '/settings/maintenance', label: 'Maintenance' },
  { href: '/settings/notifications', label: 'Notifications' },
  { href: '/settings/routing', label: 'Routing' },
  { href: '/settings/oncall', label: 'On-call' },
  { href: '/settings/ai', label: 'AI' },
  { href: '/settings/digests', label: 'Digests' },
  { href: '/settings/sign-in', label: 'Sign-in' },
  { href: '/settings/wall', label: 'Map & wall' },
  { href: '/settings/noc', label: 'NOC boards' },
  { href: '/settings/general', label: 'General' },
  { href: '/settings/audit', label: 'Audit log' },
] as const;

export function SettingsTabs() {
  const pathname = usePathname();
  return (
    <nav className="flex flex-wrap gap-1 border-b border-white/10" aria-label="Settings">
      {SETTINGS_TABS.map((t) => (
        <Link
          key={t.href}
          href={t.href}
          aria-current={pathname.startsWith(t.href) ? 'page' : undefined}
          className={cx(
            '-mb-px border-b-2 px-4 py-2 text-sm',
            pathname.startsWith(t.href)
              ? 'border-sky-400 text-white'
              : 'border-transparent text-slate-400 hover:text-slate-200',
          )}
        >
          {t.label}
        </Link>
      ))}
    </nav>
  );
}
