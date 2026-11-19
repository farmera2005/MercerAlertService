import { expect, test, type Page } from '@playwright/test';

/**
 * Remote access through a Cloudflare Tunnel: the token is checked, the worker starts the
 * connector and reports on it, and turning it off stops it. The token is well-formed but not a
 * real tunnel's, so the connector never connects (or, outside the Docker image, isn't there).
 */
const admin = {
  username: process.env.E2E_ADMIN_USER ?? 'e2e-admin',
  password: process.env.E2E_ADMIN_PASSWORD ?? 'correct-horse-battery-staple',
};

async function signIn(page: Page) {
  await page.goto('/login');
  await page.fill('#username', admin.username);
  await page.fill('#password', admin.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).not.toHaveURL(/\/login/);
}

const fakeToken = Buffer.from(
  JSON.stringify({
    a: '0123456789abcdef0123456789abcdef',
    t: '2f3e8f6a-5c1b-4d7e-9a0b-1c2d3e4f5a6b',
    s: 'ZTJlLXRlc3Qtbm90LWEtcmVhbC10dW5uZWwtc2VjcmV0',
  }),
).toString('base64');

test('the Cloudflare Tunnel is set up in Settings and the worker reports on it', async ({
  page,
}) => {
  await signIn(page);
  await page.goto('/settings/general');
  await expect(page.getByTestId('tunnel-status')).toHaveCount(0);

  await page.locator('#f-CF_TUNNEL_ENABLED').check();
  await page.fill('#f-CF_TUNNEL_TOKEN', 'cloudflared tunnel run --token nope');
  await page.getByRole('button', { name: 'Save settings' }).click();
  await expect(page.getByText(/not a tunnel token/)).toBeVisible();

  await page.fill('#f-CF_TUNNEL_TOKEN', fakeToken);
  await page.getByRole('button', { name: 'Save settings' }).click();
  await expect(page.getByText(/^Saved\.$/).first()).toBeVisible();

  // The worker picks the change up and reports what its connector is doing.
  await expect(async () => {
    await page.reload();
    const status = page.getByTestId('tunnel-status');
    await expect(status).toHaveAttribute(
      'data-state',
      /^(starting|connecting|restarting|not_installed)$/,
    );
    await expect(status).toContainText('Tunnel 2f3e8f6a-5c1b-4d7e-9a0b-1c2d3e4f5a6b');
  }).toPass({ timeout: 60_000 });

  // The token is never sent back to the browser.
  expect(await page.content()).not.toContain(fakeToken);

  await page.locator('#f-CF_TUNNEL_ENABLED').uncheck();
  await page.getByRole('button', { name: 'Save settings' }).click();
  await expect(page.getByText(/^Saved\.$/).first()).toBeVisible();
  await expect(async () => {
    await page.reload();
    await expect(page.getByTestId('tunnel-status')).toHaveCount(0);
  }).toPass({ timeout: 60_000 });
});
