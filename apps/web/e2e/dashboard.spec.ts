import { expect, test, type Page } from '@playwright/test';

/**
 * Dashboard smoke tests: overview (with a live update), incident acknowledgement and the wall.
 * Runs after setup.spec.ts (project dependency) against a stack with mock-swis; triggers a WAN
 * outage at Rockford through the mock's control API.
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

test('overview shows sites and updates live when a site goes down', async ({ page }) => {
  await signIn(page);
  await page.goto('/');
  const rockford = page.locator('[data-site="Rockford Elevator"]');
  await expect(page.getByTestId('site-grid')).toBeVisible();
  await expect(rockford).toBeVisible();
  await expect(page.getByText('Live', { exact: true })).toBeVisible();
  await page.evaluate(() => {
    (window as unknown as { __samePage: boolean }).__samePage = true;
  });

  const res = await fetch(`${control}/__mock/scenario`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'site-wan-down',
      params: { site: 'ROCK', childAlerts: 30 },
      immediate: true,
    }),
  });
  expect(res.ok).toBe(true);

  // Poll → correlation → pg_notify → SSE → refresh, with no reload of the page.
  await expect(rockford).toHaveAttribute('data-level', 'bad', { timeout: 120_000 });
  await expect(page.getByTestId('count-P1')).toContainText('1');
  await expect(page.getByTestId('noise-24h')).not.toHaveText('—');
  expect(
    await page.evaluate(() => (window as unknown as { __samePage?: boolean }).__samePage),
  ).toBe(true);
});

test('map tiles send the dashboard origin as Referer, as OpenStreetMap requires', async ({
  page,
}) => {
  // A transparent 1×1 PNG instead of the real tile (the test must not call OpenStreetMap).
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
    'base64',
  );
  const referers: Array<string | undefined> = [];
  await page.route(/tile\.openstreetmap\.org/, async (route) => {
    referers.push((await route.request().allHeaders())['referer']);
    await route.fulfill({ status: 200, contentType: 'image/png', body: png });
  });
  await signIn(page);
  await page.goto('/');
  await expect.poll(() => referers.length, { timeout: 30_000 }).toBeGreaterThan(0);
  const origin = `${new URL(page.url()).origin}/`;
  expect(new Set(referers)).toEqual(new Set([origin]));
});

test('an incident can be acknowledged and it is audited', async ({ page }) => {
  await signIn(page);
  await page.goto('/incidents?priority=P1');
  await page.getByTestId('incident-rows').getByRole('link').first().click();
  await expect(page.getByTestId('incident-title')).toHaveText('Site down — Rockford Elevator');
  await expect(page.getByTestId('timeline')).toContainText('raised');

  await page.locator('form[aria-label="Acknowledge"] input[name=text]').fill('e2e: on it');
  await page.getByRole('button', { name: 'Acknowledge' }).click();
  await expect(page.getByText(`Acknowledged by ${admin.username} at`)).toBeVisible();
  await expect(page.getByTestId('timeline')).toContainText(
    `Acknowledged by ${admin.username}: e2e: on it`,
  );
  await expect(page.getByRole('button', { name: 'Un-acknowledge' })).toBeVisible();

  // Shadow mode is on by default: the shadow post is recorded, and nobody is paged.
  await expect(page.getByTestId('notification-log')).toContainText('#mas-shadow (shadow)');

  await page.goto('/settings/audit?action=incident.');
  await expect(page.getByRole('cell', { name: 'incident.ack' }).first()).toBeVisible();
});

test('the wall shows a valid link without signing in and refuses others', async ({
  page,
  browser,
}) => {
  await signIn(page);
  await page.goto('/settings/wall');
  const seen = (await page.getByText('Your address as MAS sees it').innerText()).split(': ')[1]!;
  expect(seen, 'the web process must see real client addresses').not.toBe('unknown');

  async function createLink(name: string, cidrs: string): Promise<string> {
    await page.goto('/settings/wall');
    await page.fill('#knew-name', name);
    await page.fill('#knew-cidrs', cidrs);
    await page.getByRole('button', { name: 'Create wall link' }).click();
    return new URL(await page.getByTestId('wall-url').innerText()).pathname;
  }
  const mine = await createLink('E2E TV', seen.includes(':') ? `${seen}/128` : `${seen}/32`);
  const elsewhere = await createLink('E2E elsewhere', '10.255.255.0/24');

  const kiosk = await browser.newContext(); // no session cookie
  const wall = await kiosk.newPage();
  await wall.goto(elsewhere);
  await expect(wall.getByRole('heading', { name: 'This wall link is not valid' })).toBeVisible();

  await wall.goto(mine);
  await expect(wall.getByTestId('wall-view')).toHaveAttribute('data-view', 'incidents');
  await expect(wall.getByTestId('wall-count-P1')).toContainText('1');
  await expect(wall.getByTestId('wall-incident').first()).toContainText(
    'Site down — Rockford Elevator',
  );
  await expect(wall.getByRole('button')).toHaveCount(0);
  await expect(wall.getByRole('link')).toHaveCount(0);
  await expect(wall.getByText(/\b10\.\d+\.\d+\.\d+\b/)).toHaveCount(0);

  // Revoking takes effect at the next render.
  await page.goto('/settings/wall');
  page.once('dialog', (d) => void d.accept());
  await page.getByTestId('kiosk-E2E TV').getByRole('button', { name: 'Revoke' }).click();
  await expect(page.getByTestId('kiosk-E2E TV')).toContainText('revoked');
  await wall.reload();
  await expect(wall.getByRole('heading', { name: 'This wall link is not valid' })).toBeVisible();
  await kiosk.close();
});

test('a Teams channel can be set up and test-sent from Settings', async ({ page }) => {
  await signIn(page);
  await fetch(`${control}/__mock/sink`, { method: 'DELETE' });
  await page.goto('/settings/notifications');
  await expect(page.getByText('Shadow mode is on')).toBeVisible();

  // The mock's sink speaks plain http, which must be allowed explicitly.
  await page.locator('details:has(#f-NOTIFY_ALLOW_HTTP) > summary').click();
  await page.locator('#f-NOTIFY_ALLOW_HTTP').check();
  await page.getByRole('button', { name: 'Save notification settings' }).click();
  await expect(page.getByText(/^Saved\.$/).first()).toBeVisible();

  const row = page.getByTestId('channel-net-alerts');
  await row.locator('summary', { hasText: 'Edit' }).click();
  await row.locator('input[name=webhookUrl]').fill(`${swisUrl}/__mock/sink/net-alerts`);
  await row.getByRole('button', { name: 'Save' }).click();
  await expect(row.getByText('Saved.')).toBeVisible();
  await expect(row.getByText('webhook set')).toBeVisible();
  await row.getByRole('button', { name: 'Send test' }).click();
  await expect(row.getByText('Sent to #net-alerts.')).toBeVisible({ timeout: 45_000 });

  const sink = (await (await fetch(`${control}/__mock/sink`)).json()) as {
    records: Array<{ sink: string; body: unknown }>;
  };
  const posted = sink.records.filter((r) => r.sink === 'teams:net-alerts');
  expect(posted).toHaveLength(1);
  expect(JSON.stringify(posted[0]!.body)).toContain('MercerAlertService test message');

  // The URL is never shown again, and the audit row does not contain it.
  await expect(page.locator(`text=${swisUrl}/__mock/sink`)).toHaveCount(0);
  await page.goto('/settings/audit?action=notify.');
  await expect(page.getByRole('cell', { name: 'notify.channel.update' }).first()).toBeVisible();
  await expect(page.locator('body')).not.toContainText('/__mock/sink/net-alerts');
});
