import { expect, test, type Page } from '@playwright/test';

/**
 * Milestone 6: Ask the network (answered by the mock's fake Claude through the real tools),
 * Trends, the settings overview, devices and local accounts. Runs after the AI spec, which
 * points AI at the fake Messages API.
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

test.afterAll(async () => {
  await fetch(`${control}/__mock/reset`, { method: 'POST' }).catch(() => {});
});

test('Ask the network answers from the data and cites its sources', async ({ page }) => {
  await fetch(`${control}/__mock/anthropic`, { method: 'DELETE' });
  const res = await fetch(`${control}/__mock/scenario`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'site-wan-down',
      params: { site: 'COLD', childAlerts: 5 },
      immediate: true,
    }),
  });
  expect(res.ok).toBe(true);
  await signIn(page);
  // Wait until MAS has opened the incident the answer should cite.
  await page.goto('/incidents?priority=P1');
  await expect(page.getByTestId('incident-rows').getByRole('link').first()).toBeVisible({
    timeout: 120_000,
  });

  await page.goto('/ask');
  await page.fill('#chat-question', 'What is going on right now?');
  await page.getByRole('button', { name: 'Ask', exact: true }).click();
  await expect(page).toHaveURL(/\/ask\/\d+$/);
  const answer = page.getByTestId('chat-answer').last();
  await expect(answer).toHaveAttribute('data-status', 'ok', { timeout: 60_000 });
  await expect(answer).toContainText('The most important open item is');
  await expect(answer.getByText('Looked up 1 thing')).toBeVisible();
  const cite = answer.getByRole('link', { name: /^INC-\d+$/ }).first();
  await expect(cite).toBeVisible();
  await expect(answer.getByTestId('chat-sources')).toContainText('INC-');

  // The model saw the tools and the question, nothing else, and no addresses.
  const sent = (await (await fetch(`${control}/__mock/anthropic`)).json()) as {
    records: Array<{ task: string; user: string }>;
  };
  const chat = sent.records.filter((r) => r.task === 'chat');
  expect(chat.length).toBeGreaterThanOrEqual(2);
  for (const r of chat) expect(r.user).not.toMatch(/\b10\.\d+\.\d+\.\d+\b/);

  await cite.click();
  await expect(page).toHaveURL(/\/incidents\/\d+$/);

  await page.goto('/ask');
  await expect(page.getByTestId('chat-threads')).toContainText('What is going on right now?');
  await page.getByTestId('chat-threads').getByRole('link').first().click();
  page.once('dialog', (d) => void d.accept());
  await page.getByRole('button', { name: 'Delete' }).click();
  await expect(page).toHaveURL(/\/ask$/);
  await expect(page.getByTestId('chat-threads')).toHaveCount(0);
});

test('Trends shows the noise over time, flapping devices and top talkers', async ({ page }) => {
  await signIn(page);
  await page.goto('/trends?range=7d');
  await expect(page.getByRole('heading', { name: 'Trends' })).toBeVisible();
  await expect(page.getByTestId('trend-stats')).toContainText('Raw Orion alert raises');
  await expect(page.getByTestId('chart-raw')).toBeVisible();
  await page.getByTestId('chart-raw').getByRole('button', { name: 'Show table' }).click();
  await expect(page.getByTestId('chart-raw').getByRole('table')).toBeVisible();
  await expect(page.getByText('Top talkers')).toBeVisible();
  await expect(page.getByText('Recurring problems')).toBeVisible();
});

test('admin: checklist, devices and local accounts', async ({ page }) => {
  await signIn(page);
  await page.goto('/settings');
  await expect(page).toHaveURL(/\/settings\/overview$/);
  const list = page.getByTestId('setup-checklist');
  await expect(list).toContainText('SolarWinds connection');
  await expect(list).toContainText('Shadow mode');
  await expect(list).toContainText('AI (Claude)');

  await page.goto('/settings/devices?filter=all');
  await expect(page.getByTestId('devices')).toBeVisible();
  const fw = page.getByTestId('device-ROCK-FW01');
  await fw.locator('summary', { hasText: 'Override' }).click();
  await fw.locator('select[name=role]').selectOption('firewall');
  await fw.locator('input[name=reason]').fill('e2e: confirmed by hand');
  await fw.getByRole('button', { name: 'Save' }).click();
  await expect(fw.getByText(/applies at the next node poll/)).toBeVisible();

  await page.goto('/settings/sign-in');
  await page.locator('summary', { hasText: 'Add a local administrator' }).click();
  await page.fill('#la-new-user', 'e2e-backup');
  await page.fill('#la-new-pw', 'another-long-passphrase');
  await page.fill('#la-new-confirm', 'another-long-passphrase');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.getByText('Created e2e-backup.')).toBeVisible();
  await page.reload();
  const accounts = page.getByTestId('local-accounts');
  await expect(accounts).toContainText('e2e-backup');
  await accounts
    .locator('li', { hasText: 'e2e-backup' })
    .getByRole('button', { name: 'Disable' })
    .click();
  await expect(page.getByText('Disabled and signed out.')).toBeVisible();

  await page.goto('/settings/audit');
  await expect(page.getByRole('cell', { name: 'auth.local.create' }).first()).toBeVisible();
  await expect(page.getByRole('cell', { name: 'device.override' }).first()).toBeVisible();
});
