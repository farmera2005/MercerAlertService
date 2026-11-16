import Link from 'next/link';
import { Shell } from '@/components/shell';
import { Card } from '@/components/ui';
import { requireUser } from '@/lib/auth';

export const dynamic = 'force-dynamic';

export default async function Forbidden() {
  const user = await requireUser('/');
  return (
    <Shell user={user}>
      <Card title="Administrators only">
        <p className="text-sm text-slate-300">
          Settings can only be changed by members of the admin group. You can still view everything
          and acknowledge, snooze or resolve incidents.
        </p>
        <p className="mt-4 text-sm">
          <Link href="/" className="text-sky-300 underline">
            Back to the overview
          </Link>
        </p>
      </Card>
    </Shell>
  );
}
