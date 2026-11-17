import { createServer, type IncomingMessage, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { teamsNotice } from '@mercer/core';
import { type NotifyError } from './errors';
import { PushoverNotifier } from './pushover';
import { TeamsWorkflowsNotifier } from './teams';
import { TwilioNotifier } from './twilio';

interface Seen {
  url: string;
  headers: IncomingMessage['headers'];
  body: string;
}

let server: Server;
let base = '';
const seen: Seen[] = [];
const reply = new Map<string, { status: number; body: string; delayMs?: number }>();

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen.push({ url: req.url ?? '', headers: req.headers, body });
      const r = [...reply.entries()].find(([prefix]) => req.url!.startsWith(prefix))?.[1] ?? {
        status: 202,
        body: '',
      };
      setTimeout(() => {
        res.writeHead(r.status, {
          'content-type': 'application/json',
          'x-ms-workflow-run-id': 'run-1',
        });
        res.end(r.body);
      }, r.delayMs ?? 0);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

describe('TeamsWorkflowsNotifier', () => {
  const card = teamsNotice('MAS test', 'Hello from MAS');

  it('posts the card as JSON and returns the workflow run id', async () => {
    const r = await new TeamsWorkflowsNotifier({ allowHttp: true }).send(
      `${base}/teams/ok?sig=SECRET`,
      card,
    );
    expect(r.providerRef).toBe('run-1');
    const last = seen.at(-1)!;
    expect(last.headers['content-type']).toBe('application/json');
    expect(JSON.parse(last.body).attachments[0].content.type).toBe('AdaptiveCard');
  });

  it('classifies failures and never puts the webhook URL in the error', async () => {
    reply.set('/teams/gone', {
      status: 404,
      body: '{"error":"no flow at https://prod.logic.azure.com/x"}',
    });
    reply.set('/teams/busy', { status: 503, body: '' });
    const t = new TeamsWorkflowsNotifier({ allowHttp: true });
    const gone = await t.send(`${base}/teams/gone?sig=SECRET`, card).catch((e: NotifyError) => e);
    expect(gone).toMatchObject({ retryable: false, status: 404 });
    expect(String(gone)).not.toContain('SECRET');
    expect(String(gone)).not.toContain('logic.azure.com');
    expect(await t.send(`${base}/teams/busy`, card).catch((e: NotifyError) => e.retryable)).toBe(
      true,
    );
  });

  it('times out as a retryable error and refuses plain http by default', async () => {
    reply.set('/teams/slow', { status: 202, body: '', delayMs: 400 });
    const slow = await new TeamsWorkflowsNotifier({ allowHttp: true, timeoutMs: 100 })
      .send(`${base}/teams/slow`, card)
      .catch((e: NotifyError) => e);
    expect(slow).toMatchObject({ retryable: true });
    expect(String(slow)).toContain('no answer within');
    await expect(new TeamsWorkflowsNotifier().send(`${base}/teams/ok`, card)).rejects.toThrow(
      'must use https://',
    );
  });
});

describe('TwilioNotifier', () => {
  it('sends a form with basic auth and returns the message SID', async () => {
    reply.set('/twilio/', { status: 201, body: '{"sid":"SM123","status":"queued"}' });
    const t = new TwilioNotifier({
      accountSid: 'AC' + '0'.repeat(32),
      authToken: 'tok',
      from: '+14195550100',
      apiBase: `${base}/twilio`,
    });
    expect((await t.send('+14195550101', { body: 'P1 Site down' })).providerRef).toBe('SM123');
    const last = seen.at(-1)!;
    expect(last.url).toBe(`/twilio/2010-04-01/Accounts/AC${'0'.repeat(32)}/Messages.json`);
    expect(last.headers.authorization).toBe(
      `Basic ${Buffer.from(`AC${'0'.repeat(32)}:tok`).toString('base64')}`,
    );
    expect(Object.fromEntries(new URLSearchParams(last.body))).toEqual({
      To: '+14195550101',
      Body: 'P1 Site down',
      From: '+14195550100',
    });
  });

  it('uses a Messaging Service when the sender is an MG SID', async () => {
    reply.set('/twilio/', { status: 201, body: '{"sid":"SM2"}' });
    await new TwilioNotifier({
      accountSid: 'AC1',
      authToken: 't',
      from: 'MG' + 'a'.repeat(32),
      apiBase: `${base}/twilio`,
    }).send('+14195550101', { body: 'x' });
    expect(new URLSearchParams(seen.at(-1)!.body).get('MessagingServiceSid')).toBe(
      'MG' + 'a'.repeat(32),
    );
  });
});

describe('PushoverNotifier', () => {
  const p = {
    title: 'P1 · Site down',
    message: 'm',
    url: 'https://mas/i/x',
    url_title: 'Ack',
    priority: 1 as const,
  };

  it('returns the request id on success', async () => {
    reply.set('/pushover/', { status: 200, body: '{"status":1,"request":"req-9"}' });
    const r = await new PushoverNotifier({ appToken: 'app', apiBase: `${base}/pushover` }).send(
      'user',
      p,
    );
    expect(r.providerRef).toBe('req-9');
    expect(new URLSearchParams(seen.at(-1)!.body).get('priority')).toBe('1');
  });

  it('treats a refused message as permanent', async () => {
    reply.set('/pushover/', {
      status: 200,
      body: '{"status":0,"errors":["user identifier is invalid"]}',
    });
    const e = await new PushoverNotifier({ appToken: 'app', apiBase: `${base}/pushover` })
      .send('bad', p)
      .catch((err: NotifyError) => err);
    expect(e).toMatchObject({
      retryable: false,
      message: 'Pushover refused the message: user identifier is invalid',
    });
  });
});
