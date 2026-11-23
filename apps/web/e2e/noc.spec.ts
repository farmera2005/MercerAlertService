import { expect, test, type Page } from '@playwright/test';

/**
 * NOC boards: the built-in boards on /noc, a custom board composed in Settings, and a wall link
 * that shows it (TV mode: no links, no buttons).
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

test.describe.configure({ mode: 'serial' });

test('the built-in boards show on /noc', async ({ page }) => {
  await signIn(page);
  await page.getByRole('link', { name: 'NOC', exact: true }).click();
  const board = page.getByTestId('noc-board');
  await expect(board).toHaveAttribute('data-board', 'mission');
  for (const w of [
    'status_bar',
    'priority_counts',
    'incidents',
    'map',
    'division_health',
    'kpis',
    'ticker',
  ])
    await expect(board.locator(`[data-widget=${w}]`)).toBeVisible();
  await expect(page.getByTestId('noc-feed')).toContainText('SolarWinds');

  await page.getByRole('link', { name: 'WAN & circuits' }).click();
  await expect(board).toHaveAttribute('data-board', 'wan');
  await expect(page.getByTestId('noc-wan').locator('tbody tr').first()).toBeVisible();

  await page.getByRole('link', { name: 'Site matrix' }).click();
  await expect(page.getByTestId('noc-matrix')).toContainText('Rockford Elevator');

  await page.getByRole('link', { name: 'Shift overview' }).click();
  await expect(page.getByTestId('noc-kpis')).toContainText('Noise reduction');
  await expect(page.getByTestId('noc-chart')).toBeVisible();
});

test('an admin composes a Grain board and shows it on a wall', async ({ page, browser }) => {
  await signIn(page);
  await page.goto('/settings/noc');
  await page.selectOption('#nb-template', 'mission');
  await page.getByRole('button', { name: 'New board' }).click();
  const builder = page.getByTestId('noc-builder');
  await builder.locator('#nb-name').fill('Grain board');
  await builder.getByLabel('Division Grain').check();

  // A widget moved onto another is refused until it is moved back.
  await builder.getByRole('button', { name: /^Status bar:/ }).click();
  await page.locator('#nb-row').fill('2');
  await expect(builder.getByText('Fix the layout before saving')).toBeVisible();
  await expect(builder.getByRole('button', { name: 'Save board' })).toBeDisabled();
  await page.locator('#nb-row').fill('1');
  await expect(builder.getByText('Fix the layout before saving')).toHaveCount(0);

  await builder.getByRole('button', { name: 'Save board' }).click();
  await expect(builder.getByText('Saved “Grain board”.')).toBeVisible();
  await builder.getByRole('link', { name: 'Open it' }).click();
  const board = page.getByTestId('noc-board');
  await expect(board).toHaveAttribute('data-board', /^custom:\d+$/);
  const ref = (await board.getAttribute('data-board'))!;
  await expect(page.getByTestId('noc-divisions')).toContainText('Grain');
  await expect(page.getByTestId('noc-divisions')).not.toContainText('Corporate');

  // A wall link that shows the board.
  await page.goto('/settings/wall');
  await page.fill('#knew-name', 'NOC e2e');
  await page.getByRole('button', { name: 'Create wall link' }).click();
  const url = await page.getByTestId('wall-url').innerText();
  await page.goto('/settings/wall');
  const row = page.getByTestId('kiosk-NOC e2e');
  await row.getByText('What it shows').click();
  await row.getByLabel('NOC boards, in turn').check();
  await row.getByLabel('Grain board', { exact: true }).check();
  await row.getByRole('button', { name: 'Save' }).first().click();
  await expect(row.getByText(/Saved: 1 board/)).toBeVisible();
  await expect(row).toContainText('shows Grain board');

  const kiosk = await browser.newContext();
  const wall = await kiosk.newPage();
  await wall.goto(new URL(url).pathname);
  await expect(wall.getByTestId('wall-view')).toHaveAttribute('data-view', `board:${ref}`);
  await expect(wall.getByTestId('noc-board')).toBeVisible();
  await expect(wall.getByRole('link')).toHaveCount(0);
  await expect(wall.getByRole('button')).toHaveCount(0);
  await kiosk.close();

  // Deleting the board takes it off the wall link.
  await page.goto('/settings/noc');
  page.once('dialog', (d) => void d.accept());
  await page.locator('[data-board="Grain board"]').getByRole('button', { name: 'Delete' }).click();
  await expect(page.locator('[data-board="Grain board"]')).toHaveCount(0);
  await page.goto('/settings/wall');
  await expect(page.getByTestId('kiosk-NOC e2e')).toContainText('classic wall');
});
