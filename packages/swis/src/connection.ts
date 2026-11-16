import { errorMessage } from '@mercer/core';
import type { SwisClient } from './client';
import {
  CircuitOpenError,
  SwisHttpError,
  SwisNetworkError,
  SwisSchemaError,
  SwisTimeoutError,
} from './errors';
import { DISCOVERY } from './queries';

export interface ConnectionTestResult {
  ok: boolean;
  ms: number;
  nodes?: number;
  activeAlerts?: number;
  tlsVerification?: 'enabled' | 'DISABLED';
  error?: string;
  /** Plain-language next step for the admin. */
  hint?: string;
  /** Which settings field the problem most likely relates to. */
  field?:
    | 'SWIS_HOST'
    | 'SWIS_PORT'
    | 'SWIS_USERNAME'
    | 'SWIS_PASSWORD'
    | 'SWIS_CA_CERT_PEM'
    | 'SWIS_TLS_SERVERNAME';
}

/** Turn a SWIS failure into something an IT generalist can act on. */
export function explainSwisError(
  err: unknown,
): Pick<ConnectionTestResult, 'error' | 'hint' | 'field'> {
  const error = errorMessage(err);
  if (err instanceof SwisHttpError) {
    if (err.status === 401 || err.status === 403)
      return {
        error,
        field: 'SWIS_PASSWORD',
        hint: 'Orion rejected the username or password. Check the account (AD accounts use DOMAIN\\user).',
      };
    if (err.status === 404)
      return {
        error,
        field: 'SWIS_PORT',
        hint: 'Something answered, but it is not SWIS. Check the port (normally 17774).',
      };
    if (err.status >= 500)
      return {
        error,
        hint: 'SWIS reported an internal error. Check the SolarWinds Information Service on the Orion server.',
      };
    return {
      error,
      hint: 'SWIS rejected the query. Run discovery to check which fields this Orion version supports.',
    };
  }
  if (err instanceof SwisTimeoutError)
    return {
      error,
      field: 'SWIS_HOST',
      hint: 'No answer in time. A firewall may be blocking TCP 17774 from this server to Orion.',
    };
  if (err instanceof CircuitOpenError)
    return { error, hint: 'Too many recent failures; wait 30 seconds and try again.' };
  if (err instanceof SwisSchemaError)
    return { error, hint: 'SWIS answered, but not in the expected format.' };
  if (err instanceof SwisNetworkError) {
    if (/ERR_TLS_CERT_ALTNAME_INVALID|altnames/i.test(error))
      return {
        error,
        field: 'SWIS_TLS_SERVERNAME',
        hint: 'The certificate is for a different name. Use “Fetch certificate” — it suggests the right certificate name.',
      };
    if (/CERT|certificate|SELF_SIGNED/i.test(error))
      return {
        error,
        field: 'SWIS_CA_CERT_PEM',
        hint: 'The Orion certificate is not trusted yet. Use “Fetch certificate”, compare the fingerprint, then trust it.',
      };
    if (/ENOTFOUND|EAI_AGAIN/.test(error))
      return {
        error,
        field: 'SWIS_HOST',
        hint: 'The server name could not be resolved (DNS). Check the spelling or use the IP address.',
      };
    if (/ECONNREFUSED/.test(error))
      return {
        error,
        field: 'SWIS_PORT',
        hint: 'Nothing is listening on that port. Check the port and that the SolarWinds Information Service is running.',
      };
    if (/EHOSTUNREACH|ENETUNREACH|ETIMEDOUT/.test(error))
      return {
        error,
        field: 'SWIS_HOST',
        hint: 'The Orion server is not reachable from here. Check routing and firewalls for TCP 17774.',
      };
    if (/EPROTO|wrong version number|packet length/i.test(error))
      return {
        error,
        hint: 'The port does not speak HTTPS. If this is the test mock, set the base URL override to http://…',
      };
  }
  return { error };
}

/** Minimal end-to-end check: authenticate, run two counts. */
export async function testSwisConnection(client: SwisClient): Promise<ConnectionTestResult> {
  const started = Date.now();
  try {
    const [nodes] = await client.query<{ N: number }>(
      DISCOVERY.counts.nodes!,
      {},
      { label: 'test.nodes', retries: 0 },
    );
    const [alerts] = await client.query<{ N: number }>(
      DISCOVERY.counts.activeAlerts!,
      {},
      { label: 'test.alerts', retries: 0 },
    );
    return {
      ok: true,
      ms: Date.now() - started,
      nodes: Number(nodes?.N ?? 0),
      activeAlerts: Number(alerts?.N ?? 0),
      tlsVerification: client.getStats().tlsVerification,
    };
  } catch (err) {
    return { ok: false, ms: Date.now() - started, ...explainSwisError(err) };
  }
}
