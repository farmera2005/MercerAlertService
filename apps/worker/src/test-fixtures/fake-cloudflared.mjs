#!/usr/bin/env node
// Stands in for cloudflared in tests: `tunnel --no-autoupdate --metrics <addr> run`, token in
// TUNNEL_TOKEN. Serves /ready like cloudflared. FAKE_CLOUDFLARED_LOG (a file) records the
// arguments and whether a token arrived; a token of "crash" makes it exit with an error.
import { appendFileSync } from 'node:fs';
import { createServer } from 'node:http';

const args = process.argv.slice(2);
const token = process.env.TUNNEL_TOKEN ?? '';
const log = process.env.FAKE_CLOUDFLARED_LOG;
if (log) appendFileSync(log, JSON.stringify({ args, hasToken: token.length > 0 }) + '\n');
const ts = () => new Date().toISOString().replace(/\.\d+Z$/, 'Z');
const say = (line) => process.stderr.write(`${ts()} ${line}\n`);
if (token.startsWith('crash')) {
  say('ERR Provided Tunnel token is not valid.');
  process.exit(1);
}
const [host, port] = args[args.indexOf('--metrics') + 1].split(':');
say('INF Starting tunnel tunnelID=fake');
createServer((req, res) => {
  res.writeHead(req.url === '/ready' ? 200 : 404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ status: 200, readyConnections: 4, connectorId: 'fake-connector' }));
}).listen(Number(port), host, () => say('INF Registered tunnel connection connIndex=0'));
process.on('SIGTERM', () => process.exit(0));
