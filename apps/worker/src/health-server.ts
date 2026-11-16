import { createServer, type Server } from 'node:http';
import type { Worker } from './worker';

/** Liveness endpoint for the Docker healthcheck: GET /healthz → 200 | 503 with JSON details. */
export function startHealthServer(worker: Worker, port: number): Server {
  const server = createServer((req, res) => {
    if (req.url !== '/healthz') {
      res.writeHead(404).end();
      return;
    }
    worker
      .health()
      .then(({ ok, details }) => {
        res.writeHead(ok ? 200 : 503, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ status: ok ? 'ok' : 'unhealthy', ...details }));
      })
      .catch((err: unknown) => {
        res.writeHead(503, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ status: 'unhealthy', error: String(err) }));
      });
  });
  server.listen(port, '0.0.0.0');
  return server;
}
