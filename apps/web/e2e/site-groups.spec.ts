import { expect, test, type Page } from '@playwright/test';

/**
 * Sites from SolarWinds groups, found automatically, and site notes saved to the group
 * description. The mock names its site groups "Site - <site name>". Runs last.
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

  // Nothing to set: MAS found the site groups by itself, and says why.
  await page.goto('/settings/mapping');
  await expect(page.getByTestId('site-group-status')).toContainText('Found automatically');
  const row = page.getByTestId('site-group-rows').locator('tr', {
    hasText: 'Site - Rockford Elevator',
  });
  await expect(row).toContainText('Rockford Elevator');
  await expect(row).toContainText('kinds of device');
  await expect(page.getByTestId('site-group-rows')).not.toContainText('at the next groups poll');

  // The site's notes are the group description; edit them in MAS.
  const before = await groupDescription('Site - Rockford Elevator');
  expect(before).toBeTruthy();
  await page.goto('/settings/sites');
  const site = page.locator('details', {
    has: page.locator('summary').getByText('Rockford Elevator', { exact: true }),
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

  await expect
    .poll(() => groupDescription('Site - Rockford Elevator'), { timeout: 30_000 })
    .toBe(text);
  await expect(async () => {
    await page.reload();
    const s = page.locator('details', {
      has: page.locator('summary').getByText('Rockford Elevator', { exact: true }),
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

test('an admin can mark a found group “not a site”, and undo it', async ({ page }) => {
  await signIn(page);
  await page.goto('/settings/mapping');
  const rows = page.getByTestId('site-group-rows');
  const row = rows.locator('tr', { hasText: 'Site - Spencerville' });
  await row.getByRole('button', { name: 'Not a site: Site - Spencerville' }).click();
  await expect(rows).not.toContainText('Site - Spencerville');

  const rejected = page.getByTestId('site-group-rejected');
  await rejected.locator('summary').click();
  const item = rejected.locator('li', { hasText: 'Site - Spencerville' });
  await expect(item).toContainText('marked “not a site”');
  await item.getByRole('button', { name: 'Undo: Site - Spencerville' }).click();
  await expect(rows.locator('tr', { hasText: 'Site - Spencerville' })).toBeVisible();
  await expect(page.getByTestId('site-group-status')).toContainText('Found automatically');
});

test('a site is placed on the map from its address', async ({ page }) => {
  await signIn(page);
  // Point the address lookup at the mock's fake OpenStreetMap search (reached by the worker).
  const swis = process.env.E2E_SWIS_URL ?? 'http://mock-swis:17774';
  await page.goto('/settings/wall');
  await page
    .locator('details', { has: page.locator('#f-MAP_GEOCODER_URL') })
    .locator('summary')
    .click();
  await page.fill('#f-MAP_GEOCODER_URL', `${swis}/__mock/nominatim`);
  await expect(page.locator('#f-MAP_ADDRESS_LOOKUP')).toBeChecked();
  await page.getByRole('button', { name: 'Save map & wall settings' }).click();
  await expect(page.getByText(/^Saved\.$/).first()).toBeVisible();

  await page.goto('/settings/sites');
  const add = page.locator('form', { has: page.getByRole('button', { name: 'Add site' }) });
  await add.locator('input[name=name]').fill('Geo Test Site');
  await add.locator('input[name=address]').fill('200 S Main St, Celina, OH 45822');
  await add.getByRole('button', { name: 'Add site' }).click();
  await expect(
    add.getByText(/Placed on the map: 200 S Main St, Celina, OH 45822, Ohio/),
  ).toBeVisible({
    timeout: 20_000,
  });

  const summary = page.locator('summary', { hasText: 'Geo Test Site' });
  await expect(summary).not.toContainText('not on map');
  await summary.click();
  const form = page.locator('details', { has: summary });
  await expect(form.getByTestId('geo-status')).toContainText('On the map at: 200 S Main St');
  await expect(form.locator('input[name=lat]')).not.toHaveValue('');

  const res = await fetch(`${control}/__mock/nominatim`);
  const body = (await res.json()) as { requests: Array<{ q: string; userAgent: string }> };
  const req = body.requests.find((r) => r.q === '200 S Main St, Celina, OH 45822');
  expect(req?.userAgent).toMatch(/^MercerAlertService\//);
});
