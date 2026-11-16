'use client';

import { useActionState, useState } from 'react';
import {
  fetchCertificateAction,
  saveSectionsAction,
  testConnectionAction,
  type CertState,
  type FormState,
  type TestState,
} from '@/app/actions/settings';
import type { FieldState } from '@/lib/settings';
import { SettingField } from './setting-field';
import { Alert, Badge, Button, Card } from './ui';

function byKey(fields: FieldState[]) {
  return Object.fromEntries(fields.map((f) => [f.key, f])) as Record<string, FieldState>;
}

export function OrionPanel({ fields }: { fields: FieldState[] }) {
  const f = byKey(fields);
  const [saveState, saveAction, saving] = useActionState<FormState, FormData>(
    saveSectionsAction.bind(null, ['orion', 'orion_tls', 'orion_writeback']),
    {},
  );
  const [certState, certAction, fetching] = useActionState<CertState, FormData>(
    fetchCertificateAction,
    {},
  );
  const [testState, testAction, testing] = useActionState<TestState, FormData>(
    testConnectionAction,
    {},
  );
  // Every input is controlled: React resets uncontrolled fields after each form action, and the
  // Test / Fetch buttons are form actions too — the admin must not lose what they typed.
  const [vals, setVals] = useState<Record<string, string>>(() =>
    Object.fromEntries(fields.map((x) => [x.key, x.kind === 'secret' ? '' : x.value])),
  );
  const set = (k: string) => (v: string) => setVals((prev) => ({ ...prev, [k]: v }));

  const test = testState.result;
  const fieldError = (key: string) =>
    saveState.errors?.[key] ??
    (test && !test.ok && test.field === key ? 'Check this field' : undefined);
  const props = (k: string) => ({
    field: f[k]!,
    error: fieldError(k),
    value: vals[k] ?? '',
    onValue: set(k),
  });
  const cert = certState.result;

  return (
    <form action={saveAction} className="space-y-6" noValidate>
      <Card
        title="SolarWinds connection"
        description="Use a dedicated read-only Orion account. MAS only reads from SWIS (TCP 17774) unless write-back is enabled below."
      >
        <div className="grid gap-5 sm:grid-cols-2">
          {['SWIS_HOST', 'SWIS_PORT', 'SWIS_USERNAME', 'SWIS_PASSWORD'].map((k) =>
            f[k] ? <SettingField key={k} {...props(k)} /> : null,
          )}
        </div>
        {f.SWIS_BASE_URL && (
          <details className="mt-5 rounded-lg border border-white/10 p-4">
            <summary className="cursor-pointer text-sm font-medium text-slate-300">
              Advanced
            </summary>
            <div className="mt-4">
              <SettingField {...props('SWIS_BASE_URL')} />
            </div>
          </details>
        )}
      </Card>

      <Card
        title="Orion certificate"
        description="Orion usually presents a self-signed certificate. Fetch it, compare the thumbprint with the one on the Orion server, then trust it."
        actions={
          <Button type="submit" variant="secondary" formAction={certAction} disabled={fetching}>
            {fetching ? 'Fetching…' : 'Fetch certificate'}
          </Button>
        }
      >
        {certState.message && <Alert tone="error">{certState.message}</Alert>}
        {cert && !cert.ok && (
          <Alert tone="error" title="Could not read the certificate">
            {cert.error}
            {cert.hint && <div className="mt-1 text-red-200/80">{cert.hint}</div>}
          </Alert>
        )}
        {cert?.ok && (
          <div className="mb-5 space-y-3 rounded-lg border border-white/10 bg-slate-950/40 p-4 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium">
                {cert.report.host}:{cert.report.port}
              </span>
              {cert.report.trusted ? (
                <Badge tone="ok">already trusted</Badge>
              ) : (
                <Badge tone="warn">not trusted yet</Badge>
              )}
              {!cert.report.hostnameMatches && <Badge tone="warn">name differs from server</Badge>}
            </div>
            {cert.report.chain.map((c, i) => (
              <div key={c.fingerprint256} className="rounded border border-white/10 p-3">
                <div className="text-xs uppercase tracking-wide text-slate-400">
                  {i === 0 ? 'Server certificate' : 'Issuer'}
                </div>
                <div className="mt-1">{c.subject}</div>
                <div className="text-xs text-slate-400">Issued by {c.issuer}</div>
                <div className="text-xs text-slate-400">
                  Valid {new Date(c.validFrom).toLocaleDateString('en-US')} –{' '}
                  {new Date(c.validTo).toLocaleDateString('en-US')}
                  {c.expired && <span className="ml-2 text-red-300">EXPIRED</span>}
                </div>
                {c.subjectAltNames.length > 0 && (
                  <div className="text-xs text-slate-400">
                    Names: {c.subjectAltNames.join(', ')}
                  </div>
                )}
                <div className="mt-2 font-mono text-xs break-all text-slate-200">
                  SHA-1 thumbprint: {c.thumbprintSha1}
                </div>
                <div className="font-mono text-xs break-all text-slate-400">
                  SHA-256: {c.fingerprint256}
                </div>
              </div>
            ))}
            <p className="text-xs text-slate-400">
              Compare the thumbprint on the Orion server: run <code>certlm.msc</code> → Personal →
              Certificates → open the certificate → Details → Thumbprint. Only trust it if they
              match.
            </p>
            <Button
              type="button"
              variant="secondary"
              onClick={() => {
                set('SWIS_CA_CERT_PEM')(cert.report.recommended.pem);
                if (cert.report.suggestedServername)
                  set('SWIS_TLS_SERVERNAME')(cert.report.suggestedServername);
              }}
            >
              Trust this certificate
              {cert.report.suggestedServername ? ` (name: ${cert.report.suggestedServername})` : ''}
            </Button>
          </div>
        )}
        <div className="grid gap-5">
          {f.SWIS_CA_CERT_PEM && <SettingField {...props('SWIS_CA_CERT_PEM')} />}
          {f.SWIS_TLS_SERVERNAME && <SettingField {...props('SWIS_TLS_SERVERNAME')} />}
        </div>
        <details className="mt-5 rounded-lg border border-white/10 p-4">
          <summary className="cursor-pointer text-sm font-medium text-slate-300">Advanced</summary>
          <div className="mt-4 grid gap-5">
            {f.SWIS_CA_CERT_PATH && <SettingField {...props('SWIS_CA_CERT_PATH')} />}
            {f.SWIS_TLS_INSECURE_SKIP_VERIFY_DEV_ONLY && (
              <SettingField {...props('SWIS_TLS_INSECURE_SKIP_VERIFY_DEV_ONLY')} />
            )}
          </div>
        </details>
      </Card>

      <Card
        title="Orion write-back (optional)"
        description="Off by default. Needs a separate account with alert management rights."
      >
        <div className="grid gap-5 sm:grid-cols-2">
          {['SWIS_WRITEBACK_ENABLED', 'SWIS_WRITE_USERNAME', 'SWIS_WRITE_PASSWORD'].map((k) =>
            f[k] ? (
              <div key={k} className={k === 'SWIS_WRITEBACK_ENABLED' ? 'sm:col-span-2' : ''}>
                <SettingField {...props(k)} />
              </div>
            ) : null,
          )}
        </div>
      </Card>

      {testState.message && <Alert tone="error">{testState.message}</Alert>}
      {test?.ok && (
        <Alert tone="success" title="Connected to SolarWinds">
          {test.nodes?.toLocaleString('en-US')} nodes, {test.activeAlerts?.toLocaleString('en-US')}{' '}
          active alerts · {test.ms} ms · TLS verification{' '}
          {test.tlsVerification === 'enabled' ? 'on' : 'OFF'}
        </Alert>
      )}
      {test && !test.ok && (
        <Alert tone="error" title="Connection failed">
          {test.hint ?? test.error}
          {test.hint && <div className="mt-1 font-mono text-xs text-red-200/70">{test.error}</div>}
        </Alert>
      )}
      {saveState.message && (
        <Alert tone={saveState.ok ? 'success' : 'error'}>{saveState.message}</Alert>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" variant="secondary" formAction={testAction} disabled={testing}>
          {testing ? 'Testing…' : 'Test connection'}
        </Button>
        <Button type="submit" disabled={saving}>
          {saving ? 'Saving…' : 'Save connection'}
        </Button>
        <span className="text-xs text-slate-400">
          The test uses what is in the form, so you can try before saving.
        </span>
      </div>
    </form>
  );
}
