import Link from 'next/link';
import { notFound } from 'next/navigation';
import { chatSourceLabels, getChatMessages, getChatThread, listChatThreads } from '@mercer/db';
import { deleteThreadAction } from '@/app/actions/chat';
import { ChatThread, type ChatMessageView, type SourceView } from '@/components/chat-thread';
import { Shell } from '@/components/shell';
import { fmtTime } from '@/components/status';
import { Alert, Button } from '@/components/ui';
import { requireUser } from '@/lib/auth';
import { server } from '@/lib/server';
import { effectiveConfig } from '@/lib/settings';

const SUGGESTIONS = [
  'What is going on right now?',
  'Which sites had the most incidents this week?',
  'What were the busiest WAN links in the last 24 hours?',
  'Is anything flapping today?',
];

const hrefFor = (ref: string) =>
  ref.startsWith('INC-')
    ? `/incidents/${ref.slice(4)}`
    : ref.startsWith('NODE-')
      ? `/nodes/${ref.slice(5)}`
      : `/sites/${encodeURIComponent(ref.slice(5).toLowerCase())}`;

export async function AskView({ threadId }: { threadId: number | null }) {
  const user = await requireUser(threadId ? `/ask/${threadId}` : '/ask');
  const userKey = `${user.kind}:${user.id}`;
  const cfg = await effectiveConfig();
  const db = server().db.db;
  const thread = threadId ? await getChatThread(db, threadId, userKey) : null;
  if (threadId && !thread) notFound();
  const [threads, rows] = await Promise.all([
    listChatThreads(db, userKey),
    thread ? getChatMessages(db, thread.id) : Promise.resolve([]),
  ]);
  const refs = [...new Set(rows.flatMap((r) => r.citations.map((c) => c.ref)))];
  const labels = await chatSourceLabels(db, refs);
  const sources: Record<string, SourceView> = Object.fromEntries(
    Object.entries(labels).map(([ref, label]) => [ref, { ref, label, href: hrefFor(ref) }]),
  );
  const messages: ChatMessageView[] = rows.map((r) => ({
    id: r.id,
    role: r.role,
    text: r.text,
    status: r.status,
    citations: r.citations,
    steps: r.steps,
    time: fmtTime(r.completedAt ?? r.createdAt, cfg.timezone),
  }));
  const enabled = cfg.ai.enabled && cfg.ai.chat.enabled;

  return (
    <Shell user={user} wide>
      <div className="grid gap-8 lg:grid-cols-[16rem_1fr]">
        <aside className="space-y-3">
          <h1 className="text-2xl font-semibold">Ask the network</h1>
          <Link
            href="/ask"
            className="block rounded-md border border-white/15 px-3 py-2 text-sm text-slate-200 hover:bg-white/10"
          >
            + New conversation
          </Link>
          {threads.length > 0 && (
            <nav aria-label="Your conversations">
              <ul className="space-y-1 text-sm" data-testid="chat-threads">
                {threads.map((t) => (
                  <li key={t.id}>
                    <Link
                      href={`/ask/${t.id}`}
                      aria-current={t.id === thread?.id ? 'page' : undefined}
                      className={`block truncate rounded-md px-3 py-1.5 ${t.id === thread?.id ? 'bg-white/10 text-white' : 'text-slate-400 hover:text-slate-100'}`}
                      title={t.title}
                    >
                      {t.title}
                    </Link>
                  </li>
                ))}
              </ul>
            </nav>
          )}
          <p className="text-xs text-slate-500">
            Only you can see your conversations. They are deleted after {cfg.retention.chatDays}{' '}
            days.
          </p>
        </aside>

        <section className="min-w-0 space-y-6">
          {!enabled && (
            <Alert tone="info" title="Ask the network is not available">
              {cfg.ai.enabled
                ? 'An administrator has switched it off in Settings → AI.'
                : 'It needs AI, which is off until an administrator saves an Anthropic API key in Settings → AI.'}
            </Alert>
          )}
          {thread ? (
            <div className="flex items-start justify-between gap-4">
              <h2 className="text-lg font-semibold text-slate-100">{thread.title}</h2>
              <form action={deleteThreadAction}>
                <input type="hidden" name="id" value={thread.id} />
                <Button type="submit" variant="ghost">
                  Delete
                </Button>
              </form>
            </div>
          ) : (
            enabled && (
              <p className="text-sm text-slate-400">
                Ask about incidents, sites, devices and links. Claude looks things up in MAS’s
                monitoring data and cites what it used.
              </p>
            )
          )}
          <ChatThread
            key={thread?.id ?? 'new'}
            threadId={thread?.id ?? null}
            messages={messages}
            sources={sources}
            enabled={enabled}
            suggestions={SUGGESTIONS}
          />
        </section>
      </div>
    </Shell>
  );
}
