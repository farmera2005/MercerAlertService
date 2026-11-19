'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { askAction } from '@/app/actions/chat';
import { ChatText, type CitationView } from './chat-text';
import { useLive } from './live';
import { StatefulForm } from './stateful-form';
import { Button, Textarea } from './ui';

export interface ChatMessageView {
  id: number;
  role: 'user' | 'assistant';
  text: string;
  status: 'pending' | 'ok' | 'error' | 'refused' | 'budget_blocked';
  citations: CitationView[];
  steps: string[];
  time: string;
}

export interface SourceView {
  ref: string;
  label: string;
  href: string;
}

const NOTE: Record<string, string> = {
  error: 'No answer',
  refused: 'Declined',
  budget_blocked: 'AI budget reached',
};

function Steps({ steps, live }: { steps: string[]; live?: boolean }) {
  if (!steps.length) return null;
  if (live)
    return (
      <ul className="space-y-1 text-xs text-slate-400" aria-live="polite">
        {steps.map((s, i) => (
          <li key={i}>
            <span aria-hidden className="mr-1.5 text-sky-300">
              ›
            </span>
            {s}
          </li>
        ))}
      </ul>
    );
  return (
    <details className="text-xs text-slate-400">
      <summary className="cursor-pointer hover:text-slate-200">
        Looked up {steps.length} thing{steps.length === 1 ? '' : 's'}
      </summary>
      <ul className="mt-1.5 space-y-1 pl-3">
        {steps.map((s, i) => (
          <li key={i}>{s}</li>
        ))}
      </ul>
    </details>
  );
}

export function ChatThread({
  threadId,
  messages,
  sources,
  enabled,
  suggestions = [],
}: {
  threadId: number | null;
  messages: ChatMessageView[];
  sources: Record<string, SourceView>;
  enabled: boolean;
  suggestions?: string[];
}) {
  const router = useRouter();
  const live = useLive();
  const pending = messages.find((m) => m.role === 'assistant' && m.status === 'pending');
  const [liveSteps, setLiveSteps] = useState<string[]>([]);
  const [liveText, setLiveText] = useState('');
  const box = useRef<HTMLTextAreaElement>(null);
  const end = useRef<HTMLDivElement>(null);

  // Progress for the pending answer arrives over the live stream; "done" reloads the thread.
  useEffect(() => {
    if (!pending || !live || threadId === null) return;
    setLiveSteps([]);
    setLiveText('');
    const off = live.subscribeChat((ev) => {
      if (ev.thread !== threadId) return;
      if (ev.k === 'step' && ev.text) setLiveSteps((s) => [...s, ev.text!]);
      else if (ev.k === 'delta' && ev.text) setLiveText((t) => t + ev.text);
      else if (ev.k === 'done') router.refresh();
    });
    // If an event was missed (reconnect), the answer still shows up.
    const poll = setInterval(() => router.refresh(), 10_000);
    return () => {
      off();
      clearInterval(poll);
    };
  }, [pending?.id, live, threadId, router]);

  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' });
  }, [messages.length, liveText, liveSteps.length]);

  const cited = (m: ChatMessageView) =>
    m.citations.map((c) => sources[c.ref]).filter((s): s is SourceView => !!s);

  return (
    <div className="flex flex-col gap-6">
      <ol className="space-y-5" data-testid="chat-messages">
        {messages.map((m) =>
          m.role === 'user' ? (
            <li key={m.id} className="flex justify-end">
              <div className="max-w-[85%] rounded-2xl rounded-br-sm bg-sky-500/15 px-4 py-2.5 text-sm text-slate-100 whitespace-pre-wrap">
                {m.text}
              </div>
            </li>
          ) : (
            <li
              key={m.id}
              className="max-w-[92%] space-y-3 rounded-2xl rounded-bl-sm border border-white/10 bg-white/[0.03] px-4 py-3"
              data-testid="chat-answer"
              data-status={m.status}
            >
              {m.status === 'pending' ? (
                <>
                  <div className="flex items-center gap-2 text-xs text-slate-400">
                    <span className="h-2 w-2 animate-pulse rounded-full bg-sky-400" />
                    {liveText ? 'Writing…' : liveSteps.length ? 'Looking things up…' : 'Thinking…'}
                  </div>
                  <Steps steps={liveSteps} live />
                  {liveText && <ChatText text={liveText} />}
                </>
              ) : (
                <>
                  {m.status !== 'ok' && (
                    <div className="text-xs font-semibold uppercase tracking-wide text-amber-300">
                      {NOTE[m.status]}
                    </div>
                  )}
                  <ChatText text={m.text} citations={m.citations} />
                  {cited(m).length > 0 && (
                    <div className="border-t border-white/10 pt-2">
                      <div className="text-xs font-semibold uppercase tracking-wide text-slate-400">
                        Sources
                      </div>
                      <ul className="mt-1 space-y-0.5 text-xs" data-testid="chat-sources">
                        {cited(m).map((s) => (
                          <li key={s.ref}>
                            <a href={s.href} className="text-sky-300 hover:underline">
                              <span className="font-mono">{s.ref}</span> · {s.label}
                            </a>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <Steps steps={m.steps} />
                    <span className="text-xs text-slate-500">{m.time}</span>
                  </div>
                </>
              )}
            </li>
          ),
        )}
      </ol>
      <div ref={end} />

      {enabled ? (
        <StatefulForm
          action={askAction.bind(null, threadId)}
          label="Ask the network"
          resetOnSuccess
        >
          {(state, busy) => (
            <div className="space-y-2">
              {messages.length === 0 && suggestions.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {suggestions.map((s) => (
                    <button
                      key={s}
                      type="button"
                      className="rounded-full border border-white/15 px-3 py-1 text-xs text-slate-300 hover:bg-white/10"
                      onClick={() => {
                        if (box.current) {
                          box.current.value = s;
                          box.current.focus();
                        }
                      }}
                    >
                      {s}
                    </button>
                  ))}
                </div>
              )}
              <label htmlFor="chat-question" className="sr-only">
                Your question
              </label>
              <Textarea
                id="chat-question"
                ref={box}
                name="question"
                rows={3}
                maxLength={2000}
                className="font-sans text-sm"
                required
                placeholder="e.g. Why is Rockford down? Which links were busiest this week?"
                disabled={!!pending}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    e.currentTarget.form?.requestSubmit();
                  }
                }}
              />
              {state.errors?.question && (
                <p className="text-sm text-red-300">{state.errors.question}</p>
              )}
              <div className="flex items-center justify-between gap-3">
                <p className="text-xs text-slate-500">
                  Claude reads MAS’s monitoring data only (it cannot change anything). Answers cite
                  their sources; check them before acting.
                </p>
                <Button type="submit" disabled={busy || !!pending}>
                  {busy ? 'Sending…' : 'Ask'}
                </Button>
              </div>
            </div>
          )}
        </StatefulForm>
      ) : null}
    </div>
  );
}
