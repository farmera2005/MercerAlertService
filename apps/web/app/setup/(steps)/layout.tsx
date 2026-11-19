import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';
import { Shell } from '@/components/shell';
import { StepFooter, Stepper } from '@/components/step-nav';
import { requireAdmin } from '@/lib/auth';
import { getSettingsState } from '@/lib/settings';

export const dynamic = 'force-dynamic';

export default async function StepsLayout({ children }: { children: ReactNode }) {
  const user = await requireAdmin('/setup/orion');
  const state = await getSettingsState();
  if (state.cfg?.setupComplete) {
    // The wizard is done: each step lives on as its Settings tab.
    const step = /^\/setup\/(orion|mapping|sites|general)\b/.exec(
      (await headers()).get('x-mas-path') ?? '',
    )?.[1];
    redirect(step ? `/settings/${step}` : '/settings');
  }
  return (
    <Shell user={user}>
      <h1 className="text-2xl font-semibold">Setup</h1>
      <p className="mt-1 text-sm text-slate-400">
        You can change everything later under Settings. Nothing is polled until you press “Start
        monitoring”.
      </p>
      <div className="mt-5">
        <Stepper />
      </div>
      <div className="mt-8">{children}</div>
      <StepFooter />
    </Shell>
  );
}
