import { createHmac } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';

/**
 * Two-step sign-in for local accounts: an authenticator app (codes computed here from the secret
 * the page shows), recovery codes, a passkey (Chromium's virtual authenticator), and Settings
 * requiring it, which sends an account without one through setup at sign-in. Runs last: it turns
 * the requirement on for a while, and resets everything at the end.
 */
test.describe.configure({ mode: 'serial' });

const admin = {
  username: process.env.E2E_ADMIN_USER ?? 'e2e-admin',
  password: process.env.E2E_ADMIN_PASSWORD ?? 'correct-horse-battery-staple',
};
const second = { username: 'e2e-2fa', password: 'another-long-passphrase-2fa' };

let secret = '';
let recovery: string[] = [];
/** The code that turned the app on: refused afterwards, whatever the clock does. */
let setupCode = '';

function base32(text: string): Buffer {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of text.replace(/\s/g, '').toUpperCase()) {
    value = (value << 5) | A.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** The code for the current time step plus `ahead` (MAS accepts one step either side). */
function totp(key: string, ahead = 0): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000) + ahead));
  const h = createHmac('sha1', base32(key)).update(msg).digest();
  const o = h[h.length - 1]! & 15;
  const n = ((h[o]! & 127) << 24) | (h[o + 1]! << 16) | (h[o + 2]! << 8) | h[o + 3]!;
  return String(n % 1_000_000).padStart(6, '0');
}

async function password(page: Page, who: { username: string; password: string }) {
  await page.goto('/login');
  await page.fill('#username', who.username);
  await page.fill('#password', who.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

async function signOut(page: Page) {
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/login/);
}

const signedIn = async (page: Page) =>
  expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();

/** Set up the authenticator app on the open page; returns the recovery codes, if shown. */
async function setUpApp(page: Page): Promise<string[]> {
  await page.getByRole('button', { name: 'Set up an authenticator app' }).click();
  secret = (await page.getByTestId('totp-secret').textContent())!.trim();
  expect(secret.replace(/\s/g, '')).toMatch(/^[A-Z2-7]{32}$/);
  await expect(page.getByAltText('QR code for the authenticator app')).toBeVisible();
  await page.fill('#totp-setup-code', '000000');
  await page.getByRole('button', { name: 'Turn on' }).click();
  await expect(page.getByText(/That code is not right/)).toBeVisible();
  setupCode = totp(secret);
  await page.fill('#totp-setup-code', setupCode);
  await page.getByRole('button', { name: 'Turn on' }).click();
  const codes = page.getByTestId('recovery-codes').locator('li');
  await expect(codes).toHaveCount(10);
  return codes.allTextContents();
}

test('an account sets up an authenticator app and signs in with it or a recovery code', async ({
  page,
}) => {
  await password(page, admin);
  await signedIn(page);
  await page.goto('/settings/sign-in');
  await page.locator('summary', { hasText: 'Add a local administrator' }).click();
  await page.fill('#la-new-user', second.username);
  await page.fill('#la-new-pw', second.password);
  await page.fill('#la-new-confirm', second.password);
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.getByText(`Created ${second.username}.`)).toBeVisible();
  await signOut(page);

  // No second step yet: the password is enough.
  await password(page, second);
  await signedIn(page);
  await page.getByRole('link', { name: second.username }).click();
  await expect(page).toHaveURL(/\/account\/security/);
  recovery = await setUpApp(page);
  for (const c of recovery) expect(c).toMatch(/^[a-z2-7]{4}(-[a-z2-7]{4}){3}$/);
  await page.reload();
  await expect(page.getByTestId('recovery-left')).toHaveText('10 of 10 left.');
  await signOut(page);

  // Now the password leads to the second step. The code that turned it on can't be reused.
  await password(page, second);
  await expect(page).toHaveURL(/\/login\/two-step/);
  await page.fill('#second-step-code', setupCode);
  await page.getByRole('button', { name: 'Verify' }).click();
  await expect(page.getByText(/That code is not right/)).toBeVisible();
  await page.fill('#second-step-code', totp(secret, 1));
  await page.getByRole('button', { name: 'Verify' }).click();
  await signedIn(page);
  await signOut(page);

  // A recovery code works once.
  await password(page, second);
  await page.getByRole('button', { name: 'Use a recovery code instead' }).click();
  await page.fill('#second-step-code', recovery[0]!.toUpperCase());
  await page.getByRole('button', { name: 'Verify' }).click();
  await signedIn(page);
  await signOut(page);
  await password(page, second);
  await page.getByRole('button', { name: 'Use a recovery code instead' }).click();
  await page.fill('#second-step-code', recovery[0]!);
  await page.getByRole('button', { name: 'Verify' }).click();
  await expect(page.getByText(/That recovery code is not right/)).toBeVisible();
  await page.getByRole('button', { name: 'Sign in as someone else' }).click();
  await expect(page).toHaveURL(/\/login$/);
});

test('a passkey works as the second step', async ({ page }) => {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });

  await password(page, second);
  await page.getByRole('button', { name: 'Use a recovery code instead' }).click();
  await page.fill('#second-step-code', recovery[2]!);
  await page.getByRole('button', { name: 'Verify' }).click();
  await signedIn(page);
  await page.goto('/account/security');
  await page.fill('#passkey-name', 'E2E key');
  await page.getByRole('button', { name: 'Add a passkey' }).click();
  await expect(page.getByTestId('passkey-list')).toContainText('E2E key');
  await expect(page.getByTestId('passkey-list')).toContainText('localhost');
  await signOut(page);

  await password(page, second);
  await expect(page).toHaveURL(/\/login\/two-step/);
  await page.getByRole('button', { name: 'Use a passkey' }).click();
  await signedIn(page);
  await signOut(page);
});

test('Settings can require it, and an admin can reset it', async ({ page }) => {
  // e2e-2fa (an admin with two-step sign-in) turns the requirement on.
  await password(page, second);
  await page.getByRole('button', { name: 'Use a recovery code instead' }).click();
  await page.fill('#second-step-code', recovery[1]!);
  await page.getByRole('button', { name: 'Verify' }).click();
  await signedIn(page);
  await page.goto('/settings/sign-in');
  await expect(page.getByTestId('local-accounts')).toContainText('two-step: app + 1 passkey');
  await expect(page.getByTestId('local-accounts')).toContainText('no two-step sign-in');
  await page.locator('#f-AUTH_REQUIRE_2FA').check();
  await page.getByRole('button', { name: 'Save sign-in settings' }).click();
  await expect(page.getByText(/^Saved\.$/).first()).toBeVisible();
  await signOut(page);

  // e2e-admin has none: it sets one up before getting in.
  await password(page, admin);
  await expect(page).toHaveURL(/\/login\/two-step/);
  await expect(page.getByRole('heading', { name: 'Set up two-step sign-in' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign out' })).toHaveCount(0);
  await page.goto('/settings/general');
  await expect(page).toHaveURL(/\/login/);
  await password(page, admin);
  const adminSecretCodes = await setUpApp(page);
  expect(adminSecretCodes).toHaveLength(10);
  await page.getByRole('button', { name: 'I’ve saved them, continue' }).click();
  await signedIn(page);
  await page.goto('/account/security');
  // The last factor can't be removed while it is required.
  await expect(
    page.getByRole('form', { name: 'Remove the authenticator app' }).getByRole('button'),
  ).toBeDisabled();
  await signOut(page);

  // e2e-2fa resets e2e-admin's and turns the requirement off again (this browser has no passkey).
  await password(page, second);
  await page.getByRole('button', { name: 'Use a recovery code instead' }).click();
  await page.fill('#second-step-code', recovery[3]!);
  await page.getByRole('button', { name: 'Verify' }).click();
  await signedIn(page);
  await page.goto('/settings/sign-in');
  await page
    .getByRole('form', { name: `Reset two-step sign-in for ${admin.username}` })
    .getByRole('button')
    .click();
  await expect(page.getByText(/Two-step sign-in removed and signed out/)).toBeVisible();
  await page.locator('#f-AUTH_REQUIRE_2FA').uncheck();
  await page.getByRole('button', { name: 'Save sign-in settings' }).click();
  await expect(page.getByText(/^Saved\.$/).first()).toBeVisible();
  await signOut(page);

  await password(page, admin);
  await signedIn(page);
  await expect(page).not.toHaveURL(/two-step/);
});
