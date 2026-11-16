/**
 * Contract between the web setup wizard and the worker's on-demand jobs. Imported by the web app
 * through `@mercer/swis/setup-contract` (types + constants only, no network code).
 */
import type { ConnectionTestResult } from './connection';
import type { DiscoveryReport } from './discover';
import type { ServerCertificateReport } from './tls';

export const SETUP_QUEUES = {
  cert: 'setup.swis.cert',
  test: 'setup.swis.test',
  discover: 'setup.swis.discover',
} as const;

/** A candidate connection from the form. Absent fields fall back to saved settings. */
export interface ConnectionInput {
  host?: string;
  port?: number;
  baseUrl?: string;
  username?: string;
  /** Sealed with the master key by the web app. Omitted = use the saved password. */
  passwordSealed?: string;
  caCertPem?: string;
  servername?: string;
  insecure?: boolean;
}

export type CertJobOutput =
  { ok: true; report: ServerCertificateReport } | { ok: false; error: string; hint?: string };
export type TestJobOutput = ConnectionTestResult;
export type DiscoverJobOutput =
  { ok: true; at: string; report: DiscoveryReport } | { ok: false; error: string; hint?: string };
export type { ConnectionTestResult, DiscoveryReport, ServerCertificateReport };
