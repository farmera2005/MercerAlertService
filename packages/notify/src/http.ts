import { NotifyError, retryableStatus } from './errors';

export const DEFAULT_TIMEOUT_MS = 10_000;

export interface HttpReply {
  status: number;
  headers: Headers;
  text: string;
}

/**
 * POST with a timeout. Error messages never contain the URL: Teams webhook URLs carry their own
 * credential (the sig= parameter) and must not reach logs or the database.
 */
export async function post(
  provider: NotifyError['provider'],
  url: string,
  init: { headers: Record<string, string>; body: string },
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<HttpReply> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: init.headers,
      body: init.body,
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const e = err as Error & { cause?: { code?: string } };
    const why =
      e.name === 'TimeoutError' || e.name === 'AbortError'
        ? `no answer within ${Math.round(timeoutMs / 1000)} s`
        : (e.cause?.code ?? e.message);
    throw new NotifyError(`${provider} unreachable: ${why}`, provider, true);
  }
  const text = await res.text().catch(() => '');
  if (!res.ok)
    throw new NotifyError(
      `${provider} returned HTTP ${res.status}${snippet(text)}`,
      provider,
      retryableStatus(res.status),
      res.status,
    );
  return { status: res.status, headers: res.headers, text };
}

function snippet(body: string): string {
  const t = body.replace(/\s+/g, ' ').trim();
  if (!t) return '';
  // Provider error bodies are short JSON; keep the useful part, drop anything URL-like.
  return `: ${t.replace(/https?:\/\/\S+/g, '[url]').slice(0, 200)}`;
}
