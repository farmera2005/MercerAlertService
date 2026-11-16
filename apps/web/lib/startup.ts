import { errorMessage } from '@mercer/core';
import { server } from './server';
import { ensureSetupCode } from './setup-code';

/** Retries for a minute in case the database is still starting. */
export async function announceSetupOnStart(): Promise<void> {
  for (let attempt = 0; attempt < 12; attempt++) {
    try {
      await ensureSetupCode({ announce: true });
      return;
    } catch (err) {
      if (attempt === 11)
        server().log.error({ err: errorMessage(err) }, 'could not prepare the setup code');
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}
