import { expect, test, type Page } from '@playwright/test';

/**
 * Sites from SolarWinds groups, and site notes saved to the group description. Runs last: it
 * renames sites to their group names. The mock names its site groups "Site - <name>".
 */
const admin = {
  username: process.env.E2E_ADMIN_USER ?? 'e2e-admin',
  password: process.env.E2E_ADMIN_PASSWORD ?? 'correct-horse-battery-staple',
};
const control = process.env.E2E_MOCK_CONTROL_URL ?? 'http://127.0.0.1:17774';

test.describe.configure({ mode: 'serial' });

async function signIn(page: Page) {
  await page.goto('/login');
  await page.fill('#username', admin.username);
  await page.fill('#password', admin.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).not.toHaveURL(/\/login/);
}

/** What the mock SolarWinds holds as a group's description (read over SWIS, like MAS does). */
async function groupDescription(name: string): Promise<string | null> {
  const res = await fetch(`${control}/SolarWinds/InformationService/v3/Json/Query`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Basic ${Buffer.from('mas:mas').toString('base64')}`,
    },
    body: JSON.stringify({
      query: 'SELECT c.Description AS Description FROM Orion.Container c WHERE c.Name = @name',
      parameters: { name },
    }),
  });
  const body = (await res.json()) as { results: Array<{ Description: string | null }> };
  return body.results[0]?.Description ?? null;
}

test('sites follow SolarWinds groups, and site notes are saved to the group', async ({ page }) => {
  await signIn(page);

  // Write-back on, with the mock's account.
  await page.goto('/settings/orion');
  await page.locator('#f-SWIS_WRITEBACK_ENABLED').check();
  await page.fill('#f-SWIS_WRITE_USERNAME', 'mas');
  await page.fill('#f-SWIS_WRITE_PASSWORD', 'mas');
  await page.getByRole('button', { name: 'Save connection' }).click();
  await expect(page.getByRole('button', { name: 'Save connection' })).toBeEnabled();

  // Sites are the groups named "Site - <name>".
  await page.goto('/settings/mapping');
  await page.fill('#f-SITE_GROUP_PATTERN', '^Site - (.+)$');
  await page.getByRole('button', { name: 'Save mapping' }).click();
  await expect(page.getByRole('button', { name: 'Save mapping' })).toBeEnabled();
  // The worker re-polls groups as soon as the mapping changes.
  await expect(async () => {
    await page.reload();
    const rows = page.getByTestId('site-group-rows');
    await expect(rows.locator('tr', { hasText: 'Site - Rockford' })).toContainText('Rockford');
    await expect(rows).not.toContainText('created at the next groups poll');
  }).toPass({ timeout: 90_000 });

  // The site's notes are the group description; edit them in MAS.
  const before = await groupDescription('Site - Rockford');
  expect(before).toBeTruthy();
  await page.goto('/settings/sites');
  const site = page.locator('details', {
    has: page.locator('summary').getByText('Rockford', { exact: true }),
  });
  await site.locator('summary').click();
  await expect(site.getByText('SolarWinds group', { exact: true })).toBeVisible();
  await expect(site.locator('input[name=name]')).toHaveAttribute('readonly', '');
  const notes = site.locator('textarea[name=groupNotes]');
  await expect(notes).toHaveValue(before!);
  const text = 'Generator on site. Spectrum circuit 12345, LTE backup on the FortiGate.';
  await notes.fill(text);
  await site.getByRole('button', { name: 'Save site' }).click();
  await expect(site.getByText(/Saving the notes to SolarWinds/)).toBeVisible();

  await expect.poll(() => groupDescription('Site - Rockford'), { timeout: 30_000 }).toBe(text);
  await expect(async () => {
    await page.reload();
    const s = page.locator('details', {
      has: page.locator('summary').getByText('Rockford', { exact: true }),
    });
    await s.locator('summary').click();
    await expect(s.getByTestId('site-notes-write')).toHaveAttribute('data-status', 'ok');
  }).toPass({ timeout: 30_000 });

  // The site page shows the notes from SolarWinds.
  await page.goto('/sites');
  await page
    .getByRole('link', { name: /^Rockford\b/ })
    .first()
    .click();
  await expect(page.getByTestId('site-notes')).toContainText('Generator on site');
  await expect(page.getByTestId('site-notes')).toContainText('From SolarWinds');

  // Devices in the group are placed by it.
  await page.goto('/settings/devices?filter=all');
  await expect(page.getByTestId('devices').getByText('SolarWinds group').first()).toBeVisible();
});
