'use client';

import { useState } from 'react';

export interface TimelineRow {
  at: string;
  time: string;
  source: 'mas' | 'alert' | 'status' | 'orion';
  tone: 'bad' | 'ok' | 'info' | 'user';
  text: string;
  actor?: string;
}

const SOURCES = [
  ['mas', 'MAS'],
  ['alert', 'Orion alerts'],
  ['status', 'Device status'],
  ['orion', 'Orion events'],
] as const;

const TONE: Record<TimelineRow['tone'], { dot: string; label: string }> = {
  bad: { dot: '#d03b3b', label: 'problem' },
  ok: { dot: '#0ca30c', label: 'recovery' },
  user: { dot: '#3987e5', label: 'person' },
  info: { dot: '#898781', label: 'info' },
};

/** The merged incident timeline, with per-source filters. */
export function Timeline({ rows }: { rows: TimelineRow[] }) {
  const [shown, setShown] = useState<Set<string>>(() => new Set(SOURCES.map(([k]) => k)));
  const visible = rows.filter((r) => shown.has(r.source));
  return (
    <div>
      <div className="mb-3 flex flex-wrap gap-2 text-xs" role="group" aria-label="Show in timeline">
        {SOURCES.map(([k, label]) => {
          const n = rows.filter((r) => r.source === k).length;
          return (
            <label
              key={k}
              className="flex cursor-pointer items-center gap-1.5 rounded-md border border-white/15 px-2 py-1 text-slate-300 has-[:checked]:border-sky-400/60"
            >
              <input
                type="checkbox"
                className="accent-sky-400"
                checked={shown.has(k)}
                onChange={(e) =>
                  setShown((cur) => {
                    const next = new Set(cur);
                    if (e.target.checked) next.add(k);
                    else next.delete(k);
                    return next;
                  })
                }
              />
              {label} ({n})
            </label>
          );
        })}
      </div>
      <ol className="relative space-y-0 border-l border-white/10 pl-5" data-testid="timeline">
        {visible.map((r, i) => (
          <li key={i} className="relative py-1.5 text-sm">
            <span
              className="absolute -left-[26px] top-3 h-2.5 w-2.5 rounded-full ring-2 ring-[#12161b]"
              style={{ background: TONE[r.tone].dot }}
              title={TONE[r.tone].label}
            />
            <span className="mr-2 font-mono text-xs tabular-nums text-slate-500">{r.time}</span>
            <span className={r.tone === 'user' ? 'text-sky-100' : 'text-slate-200'}>{r.text}</span>
            <span className="ml-2 text-xs text-slate-500">
              {SOURCES.find(([k]) => k === r.source)?.[1]}
            </span>
          </li>
        ))}
        {visible.length === 0 && <li className="py-2 text-sm text-slate-500">Nothing to show.</li>}
      </ol>
    </div>
  );
}
