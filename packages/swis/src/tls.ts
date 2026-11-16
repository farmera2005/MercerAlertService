import { X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { connect, rootCertificates, type DetailedPeerCertificate } from 'node:tls';
import type { Logger } from '@mercer/core';

export interface TlsInput {
  caCertPath?: string;
  /** PEM text saved from the web setup wizard. */
  caCertPem?: string;
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
  'Credentials can be intercepted. Trust the Orion certificate in Settings → Orion certificate instead. Development only.';

function assertPem(pem: string, source: string): void {
  if (!pem.includes('BEGIN CERTIFICATE'))
    throw new Error(`${source} does not contain a PEM certificate`);
}

/**
 * The single place where TLS verification for SWIS is configured.
 * Custom certificates are *added* to Node's root store, so both a self-signed Orion certificate
 * and an internal-CA-issued one work.
 */
export function buildTlsConnectOptions(input: TlsInput, log: Logger): TlsConnectOptions {
  const opts: TlsConnectOptions = { rejectUnauthorized: !input.insecureSkipVerify };
  if (input.tlsServername) opts.servername = input.tlsServername;
  const extra: string[] = [];
  if (input.caCertPath) {
    const pem = readFileSync(input.caCertPath, 'utf8');
    assertPem(pem, `SWIS_CA_CERT_PATH=${input.caCertPath}`);
    extra.push(pem);
    log.info({ caCertPath: input.caCertPath }, 'SWIS: trusting certificate file');
  }
  if (input.caCertPem?.trim()) {
    assertPem(input.caCertPem, 'The saved Orion certificate');
    extra.push(input.caCertPem);
    log.info('SWIS: trusting the certificate saved in Settings');
  }
  if (extra.length) opts.ca = [...rootCertificates, ...extra];
  if (input.insecureSkipVerify) log.error({ security: true }, INSECURE_TLS_WARNING);
  return opts;
}

// ---------------------------------------------------------------------------------------------
// Certificate inspection for the setup wizard ("trust on first use, after comparing fingerprints")
// ---------------------------------------------------------------------------------------------

export interface CertificateInfo {
  subject: string;
  issuer: string;
  commonName: string | null;
  subjectAltNames: string[];
  validFrom: string;
  validTo: string;
  expired: boolean;
  selfSigned: boolean;
  isCa: boolean;
  fingerprint256: string;
  /** SHA-1 as Windows shows it ("Thumbprint" in certlm.msc): lowercase hex, no colons. */
  thumbprintSha1: string;
  pem: string;
}

export interface ServerCertificateReport {
  host: string;
  port: number;
  /** Leaf first. */
  chain: CertificateInfo[];
  /** Would the connection verify against the public roots plus `trustedPem`? */
  trusted: boolean;
  trustError: string | null;
  /** The certificate an admin should trust: the top of the presented chain. */
  recommended: CertificateInfo;
  /** Set when the certificate's names don't include the host (e.g. "SolarWinds-Orion"). */
  suggestedServername: string | null;
  hostnameMatches: boolean;
}

function toPem(der: Buffer): string {
  const b64 = der.toString('base64').replace(/(.{64})/g, '$1\n');
  return `-----BEGIN CERTIFICATE-----\n${b64.trim()}\n-----END CERTIFICATE-----\n`;
}

function describe(der: Buffer): CertificateInfo {
  const x = new X509Certificate(der);
  const cn = /(?:^|\n)CN=([^\n]+)/.exec(x.subject)?.[1] ?? null;
  const sans = (x.subjectAltName ?? '')
    .split(/,\s*/)
    .filter(Boolean)
    .map((s) => s.replace(/^(DNS|IP Address):/, ''));
  return {
    subject: x.subject.replace(/\n/g, ', '),
    issuer: x.issuer.replace(/\n/g, ', '),
    commonName: cn,
    subjectAltNames: sans,
    validFrom: new Date(x.validFrom).toISOString(),
    validTo: new Date(x.validTo).toISOString(),
    expired: new Date(x.validTo).getTime() < Date.now(),
    selfSigned: x.subject === x.issuer && x.checkIssued(x),
    isCa: x.ca,
    fingerprint256: x.fingerprint256,
    thumbprintSha1: x.fingerprint.replace(/:/g, '').toLowerCase(),
    pem: toPem(der),
  };
}

/**
 * Read the certificate chain a TLS server presents. Only the handshake happens: no request and no
 * credentials are sent, which is why skipping verification here is safe (it is how we *show* an
 * unknown certificate to an admin so they can compare the fingerprint before trusting it).
 */
export function fetchServerCertificate(
  host: string,
  port: number,
  opts: { servername?: string; trustedPem?: string; timeoutMs?: number } = {},
): Promise<ServerCertificateReport> {
  const servername = opts.servername ?? (isIP(host) ? undefined : host);
  return new Promise((resolve, reject) => {
    const socket = connect({
      host,
      port,
      servername,
      ca: opts.trustedPem ? [...rootCertificates, opts.trustedPem] : undefined,
      // Inspection only — see the function comment. Never used for requests.
      // eslint-disable-next-line no-restricted-syntax
      rejectUnauthorized: false,
    });
    socket.setTimeout(opts.timeoutMs ?? 10_000, () => {
      socket.destroy();
      reject(
        new Error(`No TLS response from ${host}:${port} within ${opts.timeoutMs ?? 10_000} ms`),
      );
    });
    socket.once('error', (err) => reject(err));
    socket.once('secureConnect', () => {
      try {
        const chain: CertificateInfo[] = [];
        const seen = new Set<string>();
        let cur: DetailedPeerCertificate | undefined = socket.getPeerCertificate(true);
        while (cur?.raw && !seen.has(cur.fingerprint256)) {
          seen.add(cur.fingerprint256);
          chain.push(describe(cur.raw));
          cur = cur.issuerCertificate;
        }
        if (!chain.length) throw new Error('server presented no certificate');
        const leaf = new X509Certificate(chain[0]!.pem);
        const name = servername ?? host;
        const hostnameMatches = !!(isIP(name) ? leaf.checkIP(name) : leaf.checkHost(name));
        const suggested = hostnameMatches
          ? null
          : (chain[0]!.subjectAltNames.find((n) => !/^\d/.test(n)) ?? chain[0]!.commonName);
        resolve({
          host,
          port,
          chain,
          trusted: socket.authorized,
          trustError: socket.authorized ? null : String(socket.authorizationError ?? 'not trusted'),
          recommended: chain.at(-1)!,
          suggestedServername: suggested ?? null,
          hostnameMatches,
        });
      } catch (err) {
        reject(err);
      } finally {
        socket.end();
      }
    });
  });
}
