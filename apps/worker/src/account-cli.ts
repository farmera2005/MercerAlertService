/**
 * Break-glass for local accounts, run on the VM when nobody can sign in to fix it in Settings →
 * Sign-in (for example the only admin lost both phone and recovery codes):
 *
 *   docker compose exec worker node dist/account.js reset-2fa <username>
 *
 * removes the account's authenticator app, passkeys and recovery codes and ends its sessions.
 * Audited as the command line. With two-step sign-in required, the account sets it up again at
 * its next sign-in.
 */
import { initLogger, loadConfig } from '@mercer/core';
import { createDb, findAccountByUsername, resetTwoFactor } from '@mercer/db';

const [command, username] = process.argv.slice(2);
if (command !== 'reset-2fa' || !username) {
  process.stderr.write('Usage: node dist/account.js reset-2fa <username>\n');
  process.exit(2);
}

const cfg = loadConfig();
initLogger({ service: 'mas-account', level: cfg.logLevel, version: cfg.version });
const h = createDb({ url: cfg.database.url, poolMax: 1, applicationName: 'mas-account' });
try {
  const account = await findAccountByUsername(h.db, username);
  if (!account) {
    process.stderr.write(`No local account is called “${username}”.\n`);
    process.exitCode = 1;
  } else {
    await resetTwoFactor(h.db, account.id, {
      actorType: 'system',
      actorLabel: 'command line (reset-2fa)',
    });
    process.stdout.write(
      `Two-step sign-in removed for ${account.username}, and its sessions ended. It signs in with the password now${cfg.auth.require2fa ? ', then sets up two-step sign-in again' : ''}.\n`,
    );
  }
} finally {
  await h.close();
}
