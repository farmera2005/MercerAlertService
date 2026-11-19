import { expect, test } from '@playwright/test';

const code = process.env.E2E_SETUP_CODE ?? '';
const swisUrl = process.env.E2E_SWIS_URL ?? 'http://mock-swis:17774';
const admin = { username: 'e2e-admin', password: 'correct-horse-battery-staple' };

test.describe.configure({ mode: 'serial' });

test('first-run setup is completed entirely in the browser', async ({ page }) => {
  test.skip(!code, 'E2E_SETUP_CODE not set (needs a fresh install)');

  await page.goto('/');
  await expect(page).toHaveURL(/\/setup$/);

  // Claim: a wrong code is rejected and typed values survive the round-trip.
  await page.fill('#setupCode', 'AAAA-BBBB');
  await page.fill('#username', admin.username);
  await page.fill('#password', admin.password);
  await page.fill('#confirm', admin.password);
  await page.getByRole('button', { name: /create administrator/i }).click();
  await expect(page.getByText('That setup code is not correct')).toBeVisible();
  await expect(page.locator('#username')).toHaveValue(admin.username);
  await page.fill('#setupCode', code);
  await page.fill('#password', admin.password);
  await page.fill('#confirm', admin.password);
  await page.getByRole('button', { name: /create administrator/i }).click();
  await expect(page).toHaveURL(/\/setup\/orion$/);

  // SolarWinds connection: test before saving; a failed test keeps the form.
  await page.getByText('Advanced').first().click();
  await page.fill('#f-SWIS_BASE_URL', swisUrl);
  await page.fill('#f-SWIS_USERNAME', 'mas');
  await page.fill('#f-SWIS_PASSWORD', 'not-the-password');
  await page.getByRole('button', { name: 'Test connection' }).click();
  await expect(page.getByText('Orion rejected the username or password')).toBeVisible();
  await expect(page.locator('#f-SWIS_BASE_URL')).toHaveValue(swisUrl);
  await page.fill('#f-SWIS_PASSWORD', 'mas');
  await page.getByRole('button', { name: 'Test connection' }).click();
  await expect(page.getByText('Connected to SolarWinds')).toBeVisible();
  await page.getByRole('button', { name: 'Save connection' }).click();
  await expect(page.getByText('Saved.')).toBeVisible();

  // Mapping from discovery.
  await page.getByRole('link', { name: /Next: Mapping/ }).click();
  await expect(page).toHaveURL(/\/setup\/mapping$/);
  await page.getByRole('button', { name: 'Run discovery' }).click();
  await expect(page.getByText('Every field MAS needs exists')).toBeVisible({ timeout: 120_000 });
  await page.selectOption('#f-CP_SITE_FIELD', 'Site');
  // The mock has one Site value ("Spencerville") with no profile yet.
  await expect(page.getByText('no match — resolve on the Sites step')).toHaveCount(1);
  await page.getByRole('button', { name: 'Save mapping' }).click();
  await expect(page.getByText(/Saved\.|No changes\./)).toBeVisible();

  // Sites: resolve every Orion value without a profile.
  await page.getByRole('link', { name: /Next: Sites/ }).click();
  await expect(page).toHaveURL(/\/setup\/sites$/);
  const unmatched = page.locator('form:has(input[name=value])');
  await expect(unmatched).toHaveCount(1);
  // A location can serve several divisions.
  await unmatched.first().getByLabel('Grain', { exact: true }).check();
  await unmatched.first().getByLabel('Agronomy', { exact: true }).check();
  await unmatched.first().getByRole('button', { name: 'Apply' }).click();
  await expect(unmatched).toHaveCount(0);
  const spencerville = page.locator('summary', { hasText: 'Spencerville' });
  await expect(spencerville).toContainText('confirmed');
  await expect(spencerville).toContainText('Grain, Agronomy');
  await spencerville.click();
  const form = page.locator('details', { has: spencerville });
  await expect(form.getByLabel('Grain', { exact: true })).toBeChecked();
  await expect(form.getByLabel('Agronomy', { exact: true })).toBeChecked();
  await expect(form.getByLabel('Feed', { exact: true })).not.toBeChecked();

  // General: validation, then save.
  await page.getByRole('link', { name: /Next: General/ }).click();
  await expect(page).toHaveURL(/\/setup\/general$/);
  await page.fill('#f-SWIS_POLL_ALERTS_SEC', '2');
  await page.getByRole('button', { name: 'Save settings' }).click();
  await expect(page.locator('#f-SWIS_POLL_ALERTS_SEC-error')).toContainText('at least 5');
  await page.fill('#f-SWIS_POLL_ALERTS_SEC', '15');
  await page.getByRole('button', { name: 'Save settings' }).click();
  await expect(page.getByText('Saved.')).toBeVisible();

  // Finish → monitoring.
  await page.getByRole('link', { name: /Next: Finish/ }).click();
  await expect(page).toHaveURL(/\/setup\/finish$/);
  await page.getByRole('button', { name: /Start monitoring/ }).click();
  await expect(page).toHaveURL(/welcome=1/);
  await expect(page.getByText('Monitoring started')).toBeVisible();

  // Health reports a configured system whose six pollers have all succeeded.
  await expect(async () => {
    const health = await (await page.request.get('/api/health')).json();
    expect(health.worker.mode).toBe('monitoring');
    expect(
      (health.pollers as Array<{ lastSuccessAt: string | null }>).filter((p) => p.lastSuccessAt),
    ).toHaveLength(6);
  }).toPass({ timeout: 90_000 });
});

test('settings require sign-in and the wizard is closed after setup', async ({ page }) => {
  test.skip(!code, 'E2E_SETUP_CODE not set');
  await page.goto('/settings/orion');
  await expect(page).toHaveURL(/\/login/);
  await page.fill('#username', admin.username);
  await page.fill('#password', admin.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/settings\/orion$/);
  await page.goto('/setup/orion');
  await expect(page).toHaveURL(/\/settings\/orion$/);
  await page.goto('/setup');
  await expect(page).toHaveURL(/\/setup\/orion|\/settings/);
});
