import type { PollerName } from '@mercer/db';

export const POLL_QUEUES: Record<PollerName, string> = {
  alerts: 'swis.poll.alerts',
  nodes: 'swis.poll.nodes',
  interfaces: 'swis.poll.interfaces',
  events: 'swis.poll.events',
  groups: 'swis.poll.groups',
  topology: 'swis.poll.topology',
};

export const RETENTION_QUEUE = 'maint.retention';

/** Upper bound on how long one poll job may stay active before pg-boss expires it. */
export const POLL_EXPIRE_SEC: Record<PollerName, number> = {
  alerts: 120,
  nodes: 300,
  interfaces: 600,
  events: 600,
  groups: 300,
  topology: 1800,
};
