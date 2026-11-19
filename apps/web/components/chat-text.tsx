import Link from 'next/link';
import { Fragment, type ReactNode } from 'react';

/**
 * Renders an answer: a small, safe subset of Markdown (paragraphs, bullet and numbered lists,
 * **bold**, `code`) built as React elements (no HTML injection), with [INC-42] / [NODE-7] /
 * [SITE-ROCK] citations turned into links. Usable from server and client components.
 */
export interface CitationView {
  ref: string;
  kind: 'incident' | 'node' | 'site';
  key: string;
  verified: boolean;
}

const hrefFor = (c: Pick<CitationView, 'kind' | 'key'>) =>
  c.kind === 'incident'
    ? `/incidents/${c.key}`
    : c.kind === 'node'
      ? `/nodes/${c.key}`
      : `/sites/${encodeURIComponent(c.key.toLowerCase())}`;

function inline(text: string, cites: Map<string, CitationView>, key: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(\[(?:INC-\d+|NODE-\d+|SITE-[A-Za-z0-9_-]{1,32})\]|\*\*[^*]+\*\*|`[^`]+`)/g;
  let last = 0;
  let i = 0;
  for (const m of text.matchAll(re)) {
    if (m.index > last)
      out.push(<Fragment key={`${key}-${i++}`}>{text.slice(last, m.index)}</Fragment>);
    const tok = m[0];
    if (tok.startsWith('[')) {
      const ref = tok.slice(1, -1).toUpperCase();
      const c = cites.get(ref);
      const kind = ref.startsWith('INC-') ? 'incident' : ref.startsWith('NODE-') ? 'node' : 'site';
      const k = ref.slice(ref.indexOf('-') + 1);
      const verified = c?.verified ?? false;
      out.push(
        <Link
          key={`${key}-${i++}`}
          href={hrefFor({ kind, key: k })}
          title={verified ? undefined : 'Not returned by any lookup in this conversation'}
          className={
            verified
              ? 'mx-0.5 rounded bg-sky-500/15 px-1.5 py-0.5 font-mono text-xs text-sky-200 hover:bg-sky-500/25'
              : 'mx-0.5 rounded bg-amber-500/15 px-1.5 py-0.5 font-mono text-xs text-amber-200 hover:bg-amber-500/25'
          }
        >
          {ref}
          {!verified && ' ?'}
        </Link>,
      );
    } else if (tok.startsWith('**')) {
      out.push(<strong key={`${key}-${i++}`}>{tok.slice(2, -2)}</strong>);
    } else {
      out.push(
        <code key={`${key}-${i++}`} className="rounded bg-white/10 px-1 text-[0.9em]">
          {tok.slice(1, -1)}
        </code>,
      );
    }
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(<Fragment key={`${key}-${i}`}>{text.slice(last)}</Fragment>);
  return out;
}

export function ChatText({ text, citations = [] }: { text: string; citations?: CitationView[] }) {
  const cites = new Map(citations.map((c) => [c.ref, c]));
  const blocks: ReactNode[] = [];
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  let list: { ordered: boolean; items: string[] } | null = null;
  let para: string[] = [];
  const flushPara = () => {
    if (para.length)
      blocks.push(
        <p key={`p${blocks.length}`} className="leading-relaxed">
          {inline(para.join(' '), cites, `p${blocks.length}`)}
        </p>,
      );
    para = [];
  };
  const flushList = () => {
    if (!list) return;
    const Tag = list.ordered ? 'ol' : 'ul';
    const n = blocks.length;
    blocks.push(
      <Tag
        key={`l${n}`}
        className={`${list.ordered ? 'list-decimal' : 'list-disc'} space-y-1 pl-5`}
      >
        {list.items.map((it, j) => (
          <li key={j}>{inline(it, cites, `l${n}-${j}`)}</li>
        ))}
      </Tag>,
    );
    list = null;
  };
  for (const raw of lines) {
    const line = raw.trimEnd();
    const bullet = /^\s*[-*•]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (bullet || numbered) {
      flushPara();
      const ordered = !!numbered;
      if (list && list.ordered !== ordered) flushList();
      list ??= { ordered, items: [] };
      list.items.push((bullet ?? numbered)![1]!);
    } else if (!line.trim()) {
      flushPara();
      flushList();
    } else {
      flushList();
      para.push(line.replace(/^#{1,6}\s+/, ''));
    }
  }
  flushPara();
  flushList();
  return <div className="space-y-3 text-sm text-slate-100">{blocks}</div>;
}
