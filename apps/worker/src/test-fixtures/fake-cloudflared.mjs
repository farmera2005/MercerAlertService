#!/usr/bin/env node
// Stands in for cloudflared in tests: `tunnel --no-autoupdate --metrics <addr> run`, token in
// TUNNEL_TOKEN. Serves /ready like cloudflared and logs like it (JSON lines with
// TUNNEL_LOG_OUTPUT=json). Once connected it logs the routes Cloudflare would push: web:3000,
// or for a token starting "loopback" 127.0.0.1:3000 plus a request that couldn't reach it.
// FAKE_CLOUDFLARED_LOG (a file) records the arguments and whether a token arrived; a token of
// "crash" makes it exit with an error.
import { appendFileSync } from 'node:fs';
import { createServer } from 'node:http';

const args = process.argv.slice(2);
const token = process.env.TUNNEL_TOKEN ?? '';
const log = process.env.FAKE_CLOUDFLARED_LOG;
const json = process.env.TUNNEL_LOG_OUTPUT === 'json';
if (log) appendFileSync(log, JSON.stringify({ args, hasToken: token.length > 0, json }) + '\n');
const ts = () => new Date().toISOString().replace(/\.\d+Z$/, 'Z');
const LEVEL = { INF: 'info', ERR: 'error' };
const say = (lvl, message, fields = {}) =>
  process.stderr.write(
    (json
      ? JSON.stringify({
          level: LEVEL[lvl],
          ...fields,
          time: ts(),
          ...(message ? { message } : {}),
        })
      : `${ts()} ${lvl} ${message} ${Object.entries(fields)
          .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
          .join(' ')}`.trimEnd()) + '\n',
  );
if (token.startsWith('crash')) {
  say('ERR', 'Provided Tunnel token is not valid.');
  process.exit(1);
}
const service = token.startsWith('loopback') ? 'http://127.0.0.1:3000' : 'http://web:3000';
const [host, port] = args[args.indexOf('--metrics') + 1].split(':');
say('INF', 'Starting tunnel', { tunnelID: 'fake' });
createServer((req, res) => {
  res.writeHead(req.url === '/ready' ? 200 : 404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ status: 200, readyConnections: 4, connectorId: 'fake-connector' }));
}).listen(Number(port), host, () => {
  say('INF', 'Registered tunnel connection', { connIndex: 0 });
  say('INF', 'Updated to new configuration', {
    version: 1,
    config: JSON.stringify({
      ingress: [
        { hostname: 'mas.example.net', originRequest: {}, service },
        { service: 'http_status:404' },
      ],
      'warp-routing': { enabled: false },
    }),
  });
  if (service.includes('127.0.0.1'))
    say('ERR', '', {
      connIndex: 0,
      event: 1,
      ingressRule: 0,
      originService: service,
      error:
        'Unable to reach the origin service. The service may be down or it may not be responding to traffic from cloudflared: dial tcp 127.0.0.1:3000: connect: connection refused',
    });
});
process.on('SIGTERM', () => process.exit(0));
