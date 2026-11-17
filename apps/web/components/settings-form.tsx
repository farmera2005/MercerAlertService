'use client';

import { useActionState, type ReactNode } from 'react';
import type { SettingSection } from '@mercer/core';
import { saveSectionsAction, type FormState } from '@/app/actions/settings';
import type { FieldState } from '@/lib/settings';
import { SettingField } from './setting-field';
import { Alert, Button, Card } from './ui';

export interface FormSection {
  section: SettingSection;
  title: string;
  description?: string;
  fields: FieldState[];
}

/** Generic form for one or more registry sections, saved together. */
export function SettingsForm({
  sections,
  submitLabel = 'Save',
  footer,
}: {
  sections: FormSection[];
  submitLabel?: string;
  footer?: ReactNode;
}) {
  const [state, action, pending] = useActionState<FormState, FormData>(
    saveSectionsAction.bind(
      null,
      sections.map((s) => s.section),
    ),
    {},
  );
  return (
    <form action={action} className="space-y-6" noValidate>
      {sections.map((s) => {
        const basic = s.fields.filter((f) => !f.advanced);
        const advanced = s.fields.filter((f) => f.advanced);
        return (
          <Card key={s.section} title={s.title} description={s.description}>
            <div className="grid gap-5 sm:grid-cols-2">
              {basic.map((f) => (
                <div
                  key={f.key}
                  className={['pem', 'bool', 'textarea'].includes(f.kind) ? 'sm:col-span-2' : ''}
                >
                  <SettingField field={f} error={state.errors?.[f.key]} submitted={state.values} />
                </div>
              ))}
            </div>
            {advanced.length > 0 && (
              <details className="mt-5 rounded-lg border border-white/10 p-4 open:bg-white/[0.02]">
                <summary className="cursor-pointer text-sm font-medium text-slate-300">
                  Advanced
                </summary>
                <div className="mt-4 grid gap-5 sm:grid-cols-2">
                  {advanced.map((f) => (
                    <div
                      key={f.key}
                      className={
                        ['pem', 'bool', 'textarea'].includes(f.kind) ? 'sm:col-span-2' : ''
                      }
                    >
                      <SettingField
                        field={f}
                        error={state.errors?.[f.key]}
                        submitted={state.values}
                      />
                    </div>
                  ))}
                </div>
              </details>
            )}
          </Card>
        );
      })}
      {state.message && <Alert tone={state.ok ? 'success' : 'error'}>{state.message}</Alert>}
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={pending}>
          {pending ? 'Saving…' : submitLabel}
        </Button>
        {footer}
      </div>
    </form>
  );
}
