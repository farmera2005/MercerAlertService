'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cx } from './ui';

const LINKS = [
  { href: '/', label: 'Overview', match: (p: string) => p === '/' },
  {
    href: '/incidents',
    label: 'Incidents',
    match: (p: string) => p.startsWith('/incidents'),
  },
  {
    href: '/sites',
    label: 'Sites',
    match: (p: string) => p.startsWith('/sites') || p.startsWith('/nodes'),
  },
  { href: '/digests', label: 'Digests', match: (p: string) => p.startsWith('/digests') },
];

export function NavLinks({ isAdmin }: { isAdmin: boolean }) {
  const pathname = usePathname();
  const links = isAdmin
    ? [
        ...LINKS,
        { href: '/settings', label: 'Settings', match: (p: string) => p.startsWith('/settings') },
      ]
    : LINKS;
  return (
    <nav className="flex gap-1 text-sm" aria-label="Main">
      {links.map((l) => (
        <Link
          key={l.href}
          href={l.href}
          aria-current={l.match(pathname) ? 'page' : undefined}
          className={cx(
            'rounded-md px-3 py-1.5',
            l.match(pathname) ? 'bg-white/10 text-white' : 'text-slate-400 hover:text-slate-100',
          )}
        >
          {l.label}
        </Link>
      ))}
    </nav>
  );
}
