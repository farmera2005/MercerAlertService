'use client';

import { useActionState } from 'react';
import { deleteMapImageAction, uploadMapImageAction, type UploadState } from '@/app/actions/wall';
import { Alert, Button } from './ui';

export function MapImageForm({
  current,
}: {
  current: { width: number | null; height: number | null; updatedAt: string; url: string } | null;
}) {
  const [state, action, pending] = useActionState<UploadState, FormData>(uploadMapImageAction, {});
  return (
    <div className="space-y-4">
      {current && (
        <div className="flex flex-wrap items-start gap-4">
          <img
            src={current.url}
            alt="Current offline map"
            className="max-h-40 rounded border border-white/10"
          />
          <div className="text-sm text-slate-300">
            {current.width} × {current.height} px
            <form action={deleteMapImageAction} className="mt-2">
              <Button type="submit" variant="ghost">
                Remove image
              </Button>
            </form>
          </div>
        </div>
      )}
      <form
        action={action}
        className="flex flex-wrap items-center gap-3"
        aria-label="Upload map image"
      >
        <input
          type="file"
          name="image"
          accept="image/png,image/jpeg,image/webp"
          className="text-sm text-slate-300 file:mr-3 file:rounded-md file:border-0 file:bg-white/10 file:px-3 file:py-2 file:text-slate-100"
        />
        <Button type="submit" variant="secondary" disabled={pending}>
          {pending ? 'Uploading…' : current ? 'Replace image' : 'Upload image'}
        </Button>
      </form>
      {state.message && <Alert tone={state.ok ? 'success' : 'error'}>{state.message}</Alert>}
    </div>
  );
}
