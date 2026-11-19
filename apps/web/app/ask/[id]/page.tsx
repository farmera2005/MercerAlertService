import { notFound } from 'next/navigation';
import { AskView } from '../view';

export const dynamic = 'force-dynamic';

export default async function AskThreadPage({ params }: { params: Promise<{ id: string }> }) {
  const id = Number((await params).id);
  if (!Number.isInteger(id) || id <= 0) notFound();
  return <AskView threadId={id} />;
}
