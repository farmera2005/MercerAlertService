import { notFound, redirect } from 'next/navigation';
import { resolveShortLink } from '@mercer/db';
import { server } from '@/lib/server';

export const dynamic = 'force-dynamic';

/** Short links from SMS and push (/i/K7Q2M9) → the incident page (which asks for sign-in). */
export default async function ShortLink({ params }: { params: Promise<{ code: string }> }) {
  const id = await resolveShortLink(server().db.db, (await params).code);
  if (!id) notFound();
  redirect(`/incidents/${id}?do=ack`);
}
