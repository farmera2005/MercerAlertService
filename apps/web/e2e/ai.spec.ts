import { expect, test, type Page } from '@playwright/test';

/**
 * AI layer: set the key up in Settings → AI (pointed at the mock's fake Anthropic API), test it,
 * see a summary arrive on an incident without reloading, and send a digest. Runs after the
 * dashboard spec.
 */
const admin = {
  username: process.env.E2E_ADMIN_USER ?? 'e2e-admin',
  password: process.env.E2E_ADMIN_PASSWORD ?? 'correct-horse-battery-staple',
};
const control = process.env.E2E_MOCK_CONTROL_URL ?? 'http://127.0.0.1:17774';
/** The mock as the worker reaches it (inside Docker: http://mock-swis:17774). */
const swisUrl = process.env.E2E_SWIS_URL ?? 'http://mock-swis:17774';

test.describe.configure({ mode: 'serial' });

async function signIn(page: Page) {
  await page.goto('/login');
  await page.fill('#username', admin.username);
  await page.fill('#password', admin.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).not.toHaveURL(/\/login/);
}

test.afterAll(async () => {
  await fetch(`${control}/__mock/reset`, { method: 'POST' }).catch(() => {});
});

test('AI is set up in Settings and the connection test reaches Claude', async ({ page }) => {
  await fetch(`${control}/__mock/anthropic`, { method: 'DELETE' });
  await signIn(page);
  await page.goto('/settings/ai');
  await expect(page.getByText('AI is off until an API key is saved')).toBeVisible();

  await page.fill('#f-ANTHROPIC_API_KEY', 'sk-ant-e2e-not-a-real-key');
  await page.fill('#f-AI_SUMMARY_DEBOUNCE_SEC', '0');
  await page.locator('details:has(#f-ANTHROPIC_BASE_URL) > summary').click();
  await page.fill('#f-ANTHROPIC_BASE_URL', `${swisUrl}/__mock/anthropic`);
  await page.getByRole('button', { name: 'Save AI settings' }).click();
  await expect(page.getByText(/^Saved\.$/).first()).toBeVisible();
  await page.reload();
  await expect(page.getByText('AI is on')).toBeVisible();

  await page.getByRole('button', { name: 'Test the connection' }).click();
  await expect(page.getByText(/Claude answered in [\d.]+ s using claude-opus-5-5/)).toBeVisible({
    timeout: 60_000,
  });
  // The key is never sent back to the browser.
  await expect(page.locator('body')).not.toContainText('sk-ant-e2e-not-a-real-key');
  expect(await page.content()).not.toContain('sk-ant-e2e-not-a-real-key');
});

test('a new incident gets an AI summary, live, after its templated alert', async ({ page }) => {
  await signIn(page);
  const res = await fetch(`${control}/__mock/scenario`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'ups-on-battery', params: { site: 'COLD' }, immediate: true }),
  });
  expect(res.ok).toBe(true);

  await page.goto('/incidents?q=UPS');
  const row = page.getByTestId('incident-rows').getByRole('link', { name: /UPS on battery/ });
  await expect(row.first()).toBeVisible({ timeout: 120_000 });
  await row.first().click();
  await expect(page.getByTestId('incident-title')).toContainText('UPS on battery');
  // The live stream refreshes the page when the summary is written.
  await expect(page.getByTestId('ai-summary')).toBeVisible({ timeout: 150_000 });
  await expect(page.getByTestId('ai-summary')).toContainText('First steps');
  await expect(page.getByTestId('ai-priority')).toContainText('AI second opinion: keep');
  await expect(page.getByTestId('timeline')).toContainText('AI summary:');

  const sent = (await (await fetch(`${control}/__mock/anthropic`)).json()) as {
    records: Array<{ task: string; user: string }>;
  };
  expect(sent.records.some((r) => r.task === 'summary')).toBe(true);
  for (const r of sent.records) expect(r.user).not.toMatch(/\b10\.\d+\.\d+\.\d+\b/);

  await page.goto('/settings/ai');
  await expect(page.getByTestId('ai-calls')).toContainText('Incident summary');
  await expect(page.getByTestId('ai-budget')).toContainText('Within budget');
});

test('a digest can be sent now and is kept in the archive', async ({ page }) => {
  await signIn(page);
  await page.goto('/settings/digests');
  await page.getByRole('button', { name: 'Send the daily digest now' }).click();
  await expect(page.getByText(/Network digest · .* written by Claude/)).toBeVisible({
    timeout: 120_000,
  });
  await page.goto('/digests');
  const first = page.getByTestId('digest-list').getByRole('link').first();
  await expect(first).toBeVisible();
  await first.click();
  await expect(page.getByTestId('digest-title')).toContainText('Network digest');
  await expect(page.getByTestId('digest')).toContainText('Written by Claude from MAS data');

  await page.goto('/settings/audit?action=digest.');
  await expect(page.getByRole('cell', { name: 'digest.send' }).first()).toBeVisible();
});
