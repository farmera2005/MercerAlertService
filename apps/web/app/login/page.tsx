import { redirect } from 'next/navigation';
import { countActiveAccounts } from '@mercer/db';
import { LoginForm } from '@/components/login-form';
import { Card } from '@/components/ui';
import { server } from '@/lib/server';

export const dynamic = 'force-dynamic';

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  if ((await countActiveAccounts(server().db.db)) === 0) redirect('/setup');
  const { next } = await searchParams;
  return (
    <main className="mx-auto max-w-sm px-6 py-20">
      <h1 className="text-2xl font-semibold">Sign in</h1>
      <p className="mt-2 text-sm text-slate-400">Mercer Landmark · Network Status</p>
      <Card className="mt-6">
        <LoginForm next={next && next.startsWith('/') ? next : '/'} />
      </Card>
    </main>
  );
}
