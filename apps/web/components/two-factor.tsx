'use client';

import { useActionState, useEffect, useState, useSyncExternalStore, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import {
  browserSupportsWebAuthn,
  startAuthentication,
  startRegistration,
} from '@simplewebauthn/browser';
import {
  cancelSignInAction,
  completeSignInAction,
  confirmTotpSetupAction,
  disableTotpAction,
  removePasskeyAction,
  newRecoveryCodesAction,
  passkeyRegistrationOptionsAction,
  passkeyRegistrationVerifyAction,
  passkeySignInOptionsAction,
  passkeySignInVerifyAction,
  verifySecondStepAction,
  startTotpSetupAction,
  type TwoStepState,
} from '@/app/actions/two-factor';
import { StatefulForm } from './stateful-form';
import { Alert, Button, FieldShell, Input } from './ui';

function passkeyProblem(): string | null {
  if (!window.isSecureContext) return 'Passkeys need MAS over HTTPS.';
  if (!browserSupportsWebAuthn()) return 'This browser does not support passkeys.';
  return null;
}
const noSubscribe = () => () => {};
/** Known only in the browser; null while rendering on the server. */
const usePasskeyProblem = () => useSyncExternalStore(noSubscribe, passkeyProblem, () => null);

function webauthnError(err: unknown): string {
  const name = (err as { name?: string })?.name;
  if (name === 'NotAllowedError') return 'Cancelled, or the passkey prompt timed out.';
  if (name === 'InvalidStateError') return 'This passkey is already registered.';
  return 'The passkey did not work. Try again, or use another way.';
}

/** Shown once: the codes, ways to keep them, and (during a sign-in) the way on. */
export function RecoveryCodes({
  codes,
  complete = false,
  refreshOnDone = false,
}: {
  codes: string[];
  /** During a sign-in: the button finishes it. */
  complete?: boolean;
  /** Account security: show the page's new state once the codes have been seen. */
  refreshOnDone?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const router = useRouter();
  const text = `MercerAlertService recovery codes (each works once)\n\n${codes.join('\n')}\n`;
  return (
    <div className="space-y-4" data-testid="recovery-codes">
      <Alert tone="warning" title="Save your recovery codes">
        If you lose your phone or passkey, each of these signs you in once. They are shown only now:
        keep them in your password manager or another safe place.
      </Alert>
      <ol className="grid grid-cols-2 gap-2 rounded-lg bg-slate-950/70 p-4 font-mono text-sm text-slate-100">
        {codes.map((c) => (
          <li key={c}>{c}</li>
        ))}
      </ol>
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="secondary"
          onClick={() =>
            void navigator.clipboard?.writeText(text).then(
              () => setCopied(true),
              () => setCopied(false),
            )
          }
        >
          {copied ? 'Copied' : 'Copy'}
        </Button>
        <Button
          type="button"
          variant="secondary"
          onClick={() => {
            const a = document.createElement('a');
            a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
            a.download = 'mas-recovery-codes.txt';
            a.click();
            URL.revokeObjectURL(a.href);
          }}
        >
          Download
        </Button>
        {complete ? (
          <form action={completeSignInAction}>
            <Button type="submit">I’ve saved them, continue</Button>
          </form>
        ) : (
          refreshOnDone && (
            <Button type="button" onClick={() => router.refresh()}>
              I’ve saved them
            </Button>
          )
        )}
      </div>
    </div>
  );
}

/** After a factor was added: recovery codes, or straight on (sign-in), or a refreshed page. */
function Added({ state }: { state: TwoStepState }) {
  const router = useRouter();
  const codes = !!state.recoveryCodes?.length;
  const [, finish] = useTransition();
  useEffect(() => {
    if (codes) return;
    if (state.complete) finish(() => completeSignInAction());
    else router.refresh();
  }, [codes, state.complete, router]);
  if (state.recoveryCodes?.length)
    return <RecoveryCodes codes={state.recoveryCodes} complete={state.complete} refreshOnDone />;
  return <Alert tone="success">{state.complete ? 'Signing in…' : state.message}</Alert>;
}

export function TotpSetup({ replace = false }: { replace?: boolean }) {
  const [setup, setSetup] = useState<{ token: string; secret: string; qr: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, start] = useTransition();
  const [state, confirm, pending] = useActionState<TwoStepState, FormData>(
    confirmTotpSetupAction,
    {},
  );
  if (state.ok) return <Added state={state} />;
  if (!setup)
    return (
      <div className="space-y-3">
        <Button
          type="button"
          variant={replace ? 'secondary' : 'primary'}
          disabled={starting}
          onClick={() =>
            start(async () => {
              const r = await startTotpSetupAction();
              if (r.ok) setSetup({ token: r.token, secret: r.secret, qr: r.qr });
              else setError(r.message);
            })
          }
        >
          {replace ? 'Move to a new phone or app' : 'Set up an authenticator app'}
        </Button>
        {error && <Alert tone="error">{error}</Alert>}
      </div>
    );
  return (
    <div className="space-y-4" data-testid="totp-setup">
      <ol className="list-decimal space-y-2 pl-5 text-sm text-slate-300">
        <li>
          In Microsoft Authenticator, Google Authenticator, 1Password or a similar app, add an
          account and scan this code.
        </li>
        <li>Type the six-digit code the app shows.</li>
      </ol>
      <div className="flex flex-wrap items-start gap-6">
        <img
          src={setup.qr}
          alt="QR code for the authenticator app"
          width={192}
          height={192}
          className="rounded-lg bg-white p-2"
        />
        <div className="min-w-[220px] flex-1 space-y-2 text-sm">
          <p className="text-slate-400">Can’t scan? Enter this key in the app instead:</p>
          <code
            className="block break-all rounded bg-slate-950/70 px-3 py-2 font-mono text-sky-200"
            data-testid="totp-secret"
          >
            {setup.secret}
          </code>
          <p className="text-xs text-slate-500">Time-based, 6 digits, every 30 seconds.</p>
        </div>
      </div>
      <form action={confirm} className="flex flex-wrap items-end gap-3" noValidate>
        <input type="hidden" name="token" value={setup.token} />
        <FieldShell id="totp-setup-code" label="Code from the app">
          <Input
            id="totp-setup-code"
            name="code"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={9}
            className="w-40 font-mono tracking-widest"
          />
        </FieldShell>
        <Button type="submit" disabled={pending}>
          {pending ? 'Checking…' : 'Turn on'}
        </Button>
      </form>
      {state.message && <Alert tone="error">{state.message}</Alert>}
    </div>
  );
}

export function PasskeyAdd({ suggestedName }: { suggestedName: string }) {
  const [name, setName] = useState(suggestedName);
  const [state, setState] = useState<TwoStepState>({});
  const [busy, run] = useTransition();
  const problem = usePasskeyProblem();

  if (state.ok) return <Added state={state} />;
  return (
    <div className="space-y-3" data-testid="passkey-add">
      <div className="flex flex-wrap items-end gap-3">
        <FieldShell id="passkey-name" label="Name for this passkey">
          <Input
            id="passkey-name"
            value={name}
            maxLength={60}
            onChange={(e) => setName(e.target.value)}
            className="w-64"
          />
        </FieldShell>
        <Button
          type="button"
          variant="secondary"
          disabled={busy || !!problem}
          onClick={() =>
            run(async () => {
              const o = await passkeyRegistrationOptionsAction();
              if (!o.ok) return setState({ ok: false, message: o.message });
              try {
                const response = await startRegistration({ optionsJSON: o.options });
                setState(await passkeyRegistrationVerifyAction(o.token, response, name));
              } catch (err) {
                setState({ ok: false, message: webauthnError(err) });
              }
            })
          }
        >
          {busy ? 'Waiting for the passkey…' : 'Add a passkey'}
        </Button>
      </div>
      {problem && <p className="text-xs text-slate-400">{problem}</p>}
      {state.message && <Alert tone="error">{state.message}</Alert>}
    </div>
  );
}

export function NewRecoveryCodes() {
  const [state, run, pending] = useActionState<TwoStepState, FormData>(newRecoveryCodesAction, {});
  if (state.ok && state.recoveryCodes) return <RecoveryCodes codes={state.recoveryCodes} />;
  return (
    <form action={run} className="space-y-3">
      <Button type="submit" variant="secondary" disabled={pending}>
        Make new recovery codes
      </Button>
      {state.message && <Alert tone={state.ok ? 'success' : 'error'}>{state.message}</Alert>}
    </form>
  );
}

/** The second sign-in step: passkey, authenticator code, or a recovery code. */
export function SecondStep({
  hasTotp,
  passkeysHere,
  passkeysElsewhere,
  recoveryLeft,
}: {
  hasTotp: boolean;
  passkeysHere: number;
  /** Addresses this account's other passkeys belong to. */
  passkeysElsewhere: string[];
  recoveryLeft: number;
}) {
  const [useRecovery, setUseRecovery] = useState(!hasTotp && passkeysHere === 0);
  const [state, verify, pending] = useActionState<TwoStepState, FormData>(
    verifySecondStepAction,
    {},
  );
  const [passkey, setPasskey] = useState<TwoStepState>({});
  const [busy, run] = useTransition();
  const problem = usePasskeyProblem();
  const [, finish] = useTransition();
  useEffect(() => {
    if (passkey.ok && passkey.complete) finish(() => completeSignInAction());
  }, [passkey]);

  return (
    <div className="space-y-6">
      {passkeysHere > 0 && (
        <div className="space-y-2">
          <Button
            type="button"
            className="w-full"
            disabled={busy || !!problem}
            onClick={() =>
              run(async () => {
                const o = await passkeySignInOptionsAction();
                if (!o.ok) return setPasskey({ ok: false, message: o.message });
                try {
                  const response = await startAuthentication({ optionsJSON: o.options });
                  setPasskey(await passkeySignInVerifyAction(response));
                } catch (err) {
                  setPasskey({ ok: false, message: webauthnError(err) });
                }
              })
            }
          >
            {busy ? 'Waiting for the passkey…' : 'Use a passkey'}
          </Button>
          {problem && <p className="text-xs text-slate-400">{problem}</p>}
          {passkey.message && !passkey.ok && <Alert tone="error">{passkey.message}</Alert>}
        </div>
      )}
      {passkeysHere === 0 && passkeysElsewhere.length > 0 && (
        <p className="text-sm text-slate-400">
          Your passkeys were made on {passkeysElsewhere.join(', ')} and only work there.
        </p>
      )}
      {(hasTotp || useRecovery) && (
        <form action={verify} className="space-y-4" noValidate>
          <input type="hidden" name="kind" value={useRecovery ? 'recovery' : 'totp'} />
          <FieldShell
            id="second-step-code"
            label={useRecovery ? 'Recovery code' : 'Code from your authenticator app'}
            help={
              useRecovery
                ? `One of the codes you saved when you set this up (${recoveryLeft} left).`
                : undefined
            }
          >
            <Input
              id="second-step-code"
              name="code"
              key={useRecovery ? 'recovery' : 'totp'}
              autoFocus
              autoComplete={useRecovery ? 'off' : 'one-time-code'}
              inputMode={useRecovery ? 'text' : 'numeric'}
              className="font-mono tracking-widest"
            />
          </FieldShell>
          {state.message && <Alert tone="error">{state.message}</Alert>}
          <Button type="submit" disabled={pending} className="w-full">
            {pending ? 'Checking…' : 'Verify'}
          </Button>
        </form>
      )}
      <div className="flex flex-wrap justify-between gap-2 text-sm">
        {recoveryLeft > 0 && (
          <button
            type="button"
            className="text-slate-400 underline hover:text-white"
            onClick={() => setUseRecovery((v) => !v)}
          >
            {useRecovery
              ? hasTotp
                ? 'Use the authenticator app'
                : 'Back'
              : 'Use a recovery code instead'}
          </button>
        )}
        <form action={cancelSignInAction}>
          <button type="submit" className="text-slate-400 underline hover:text-white">
            Sign in as someone else
          </button>
        </form>
      </div>
    </div>
  );
}

export function RemoveTotpButton({ blocked }: { blocked: boolean }) {
  return (
    <StatefulForm action={disableTotpAction} label="Remove the authenticator app">
      {(_, pending) => (
        <Button
          type="submit"
          variant="ghost"
          disabled={pending || blocked}
          title={blocked ? 'Required: add a passkey first' : undefined}
        >
          Remove
        </Button>
      )}
    </StatefulForm>
  );
}

export function RemovePasskeyButton({
  id,
  name,
  blocked,
}: {
  id: number;
  name: string;
  blocked: boolean;
}) {
  return (
    <StatefulForm action={removePasskeyAction} label={`Remove passkey ${name}`} className="ml-auto">
      {(_, pending) => (
        <>
          <input type="hidden" name="id" value={id} />
          <Button
            type="submit"
            variant="ghost"
            disabled={pending || blocked}
            title={blocked ? 'Required: set up another way first' : undefined}
          >
            Remove
          </Button>
        </>
      )}
    </StatefulForm>
  );
}
