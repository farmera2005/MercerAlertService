import type { AppConfig, Logger } from '@mercer/core';
import type { Db } from '@mercer/db';
import type { SchemaProbe, SwisClient, SwisFetcher } from '@mercer/swis';
import type { SiteResolver } from './site-resolver';
import type { SourceMonitor } from './source-monitor';

export interface WorkerContext {
  cfg: AppConfig;
  log: Logger;
  db: Db;
  swis: { client: SwisClient; probe: SchemaProbe; fetcher: SwisFetcher };
  sites: SiteResolver;
  source: SourceMonitor;
  /** Called after a poll recorded ≥1 transition (M2 wires correlation here). */
  onTransitions: (poller: string, count: number) => Promise<void>;
  now: () => Date;
}
