/** Next.js server start hook: announce the first-run setup code in the log. */
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const { announceSetupOnStart } = await import('./lib/startup');
  void announceSetupOnStart();
}
