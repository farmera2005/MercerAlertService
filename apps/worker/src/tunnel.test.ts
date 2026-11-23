import { chmodSync, mkdtempSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { TunnelSupervisor, type TunnelSnapshot } from './tunnel';

const FAKE = fileURLToPath(new URL('./test-fixtures/fake-cloudflared.mjs', import.meta.url));
chmodSync(FAKE, 0o755);

const silent = {
  debug() {},
  info() {},
  warn() {},
  error() {},
} as never;

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

const tunnel = (token: string | null, enabled = true) => ({
  enabled,
  token,
  tunnelId: token ? '2f3e8f6a-5c1b-4d7e-9a0b-1c2d3e4f5a6b' : null,
  connectorHost: 'worker',
});

async function until(check: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('TunnelSupervisor', () => {
  let sup: TunnelSupervisor | null = null;
  afterEach(async () => {
    await sup?.stop();
    sup = null;
  });

  async function make(binary = FAKE) {
    const reports: TunnelSnapshot[] = [];
    const logFile = join(mkdtempSync(join(tmpdir(), 'tunnel-')), 'calls.log');
    sup = new TunnelSupervisor({
      log: silent,
      report: (s) => void reports.push(s),
      binary,
      metricsAddr: `127.0.0.1:${await freePort()}`,
      probeMs: 50,
      backoffMs: 50,
      env: { FAKE_CLOUDFLARED_LOG: logFile },
    });
    const calls = () => {
      try {
        return readFileSync(logFile, 'utf8');
      } catch {
        return '';
      }
    };
    return { reports, calls };
  }

  it('runs the connector with the token in its environment and reports it connected', async () => {
    const { reports, calls } = await make();
    await sup!.apply(tunnel('eyJhIjoiMSJ9-token'));
    await until(() => sup!.snapshot.state === 'connected');
    expect(sup!.snapshot).toMatchObject({ connections: 4, lastError: null });
    const call = JSON.parse(calls().trim().split('\n')[0]!) as {
      args: string[];
      hasToken: boolean;
    };
    expect(call.hasToken).toBe(true);
    expect(call.args.join(' ')).not.toContain('token');
    expect(reports.map((r) => r.state)).toContain('starting');

    // Unchanged settings leave it running; turning it off stops it.
    await sup!.apply(tunnel('eyJhIjoiMSJ9-token'));
    expect(calls().trim().split('\n')).toHaveLength(1);
    await sup!.apply(tunnel('eyJhIjoiMSJ9-token', false));
    expect(sup!.snapshot.state).toBe('off');
  });

  it('restarts a connector that exits, and keeps its error', async () => {
    const { calls } = await make();
    await sup!.apply(tunnel('crash-token'));
    // Wait for the state itself: right after a start is logged, the connector may not have
    // exited yet (state "starting"), so counting starts alone races on fast machines.
    await until(() => sup!.snapshot.state === 'restarting' && sup!.snapshot.restarts >= 2, 10_000);
    expect(calls().trim().split('\n').length).toBeGreaterThanOrEqual(2);
    expect(sup!.snapshot.lastError).toMatch(/token is not valid/);
  });

  it('says when cloudflared is missing', async () => {
    await make('/nonexistent/cloudflared');
    await sup!.apply(tunnel('eyJhIjoiMSJ9-token'));
    await until(() => sup!.snapshot.state === 'not_installed');
    expect(sup!.snapshot.lastError).toMatch(/not installed/);
  });
});
