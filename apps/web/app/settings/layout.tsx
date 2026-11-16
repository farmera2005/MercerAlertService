import type { ReactNode } from 'react';
import { Shell } from '@/components/shell';
import { SettingsTabs } from '@/components/step-nav';
import { requireAdmin } from '@/lib/auth';

export const dynamic = 'force-dynamic';

export default async function SettingsLayout({ children }: { children: ReactNode }) {
  const user = await requireAdmin('/settings');
  return (
    <Shell user={user.username}>
      <h1 className="text-2xl font-semibold">Settings</h1>
      <p className="mt-1 text-sm text-slate-400">
        Changes apply within seconds — no restart or config file needed.
      </p>
      <div className="mt-6">
        <SettingsTabs />
      </div>
      <div className="mt-8">{children}</div>
    </Shell>
  );
}
