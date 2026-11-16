/** Next.js server start hook. */
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  // First: record real client addresses for audit rows and wall IP allowlists.
  const { installPeerIpHook } = await import('./lib/peer-ip');
  installPeerIpHook();
  const { announceSetupOnStart } = await import('./lib/startup');
  void announceSetupOnStart();
}
