import Link from 'next/link';
import type { ReactNode } from 'react';
import { logoutAction } from '@/app/actions/auth';

export function Shell({
  children,
  user,
  wide,
}: {
  children: ReactNode;
  user?: string | null;
  wide?: boolean;
}) {
  return (
    <div className="min-h-screen">
      <header className="border-b border-white/10 bg-slate-950/60">
        <div
          className={`mx-auto flex items-center justify-between px-6 py-3 ${wide ? 'max-w-6xl' : 'max-w-4xl'}`}
        >
          <Link href="/" className="font-semibold tracking-tight text-slate-100">
            Mercer Landmark · Network Status
          </Link>
          {user && (
            <div className="flex items-center gap-4 text-sm text-slate-400">
              <Link href="/settings" className="hover:text-white">
                Settings
              </Link>
              <span>{user}</span>
              <form action={logoutAction}>
                <button type="submit" className="hover:text-white">
                  Sign out
                </button>
              </form>
            </div>
          )}
        </div>
      </header>
      <main className={`mx-auto px-6 py-8 ${wide ? 'max-w-6xl' : 'max-w-4xl'}`}>{children}</main>
    </div>
  );
}
