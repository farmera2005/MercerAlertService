import { readFileSync } from 'node:fs';
import { rootCertificates } from 'node:tls';
import type { Logger } from '@mercer/core';

export interface TlsInput {
  caCertPath?: string;
  tlsServername?: string;
  insecureSkipVerify: boolean;
}

export interface TlsConnectOptions {
  ca?: string[];
  servername?: string;
  rejectUnauthorized: boolean;
}

export const INSECURE_TLS_WARNING =
  'SWIS TLS CERTIFICATE VERIFICATION IS DISABLED (SWIS_TLS_INSECURE_SKIP_VERIFY_DEV_ONLY=true). ' +
  'Credentials can be intercepted. Use SWIS_CA_CERT_PATH with the Orion certificate instead. Development only.';

/**
 * The single place where TLS verification for SWIS is configured.
 * The custom CA bundle is *added* to Node's root store, so both a self-signed Orion certificate
 * and an internal-CA-issued one work.
 */
export function buildTlsConnectOptions(input: TlsInput, log: Logger): TlsConnectOptions {
  const opts: TlsConnectOptions = { rejectUnauthorized: !input.insecureSkipVerify };
  if (input.tlsServername) opts.servername = input.tlsServername;
  if (input.caCertPath) {
    const pem = readFileSync(input.caCertPath, 'utf8');
    if (!pem.includes('BEGIN CERTIFICATE')) {
      throw new Error(`SWIS_CA_CERT_PATH=${input.caCertPath} does not contain a PEM certificate`);
    }
    opts.ca = [...rootCertificates, pem];
    log.info({ caCertPath: input.caCertPath }, 'SWIS: using custom CA bundle');
  }
  if (input.insecureSkipVerify) log.error({ security: true }, INSECURE_TLS_WARNING);
  return opts;
}
