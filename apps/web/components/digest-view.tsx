import Link from 'next/link';
import { Fragment, type ReactNode } from 'react';
import { digestFactRows, type DigestContent, type DigestFacts } from '@mercer/core';

/** Turn "INC-42" in digest text into links to the incident. */
function withLinks(text: string): ReactNode {
  const parts = text.split(/\b(INC-\d+)\b/);
  return parts.map((p, i) =>
    /^INC-\d+$/.test(p) ? (
      <Link key={i} href={`/incidents/${p.slice(4)}`} className="text-sky-300 hover:underline">
        {p}
      </Link>
    ) : (
      <Fragment key={i}>{p}</Fragment>
    ),
  );
}

export function DigestView({
  content,
  facts,
  source,
}: {
  content: DigestContent;
  facts: DigestFacts;
  source: 'ai' | 'template';
}) {
  return (
    <div className="space-y-6" data-testid="digest">
      <p className="text-lg font-medium text-slate-50">{withLinks(content.headline)}</p>
      {content.sections.map((s) => (
        <section key={s.title}>
          <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-400">
            {s.title}
          </h2>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-slate-200">
            {s.bullets.map((b, i) => (
              <li key={i}>{withLinks(b)}</li>
            ))}
          </ul>
        </section>
      ))}
      <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1.5 rounded-lg border border-white/10 p-4 text-sm">
        {digestFactRows(facts).map((r) => (
          <Fragment key={r.title}>
            <dt className="text-slate-400">{r.title}</dt>
            <dd className="tabular-nums text-slate-100">{r.value}</dd>
          </Fragment>
        ))}
      </dl>
      <p className="text-xs text-slate-500">
        {source === 'ai'
          ? 'Written by Claude from MAS data. The table above is computed by MAS.'
          : 'Generated from a template (AI was off, over budget or unavailable).'}
      </p>
    </div>
  );
}
