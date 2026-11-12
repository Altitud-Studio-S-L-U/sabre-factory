import { test, expect } from '@playwright/test';
import { mockFactoryApi } from './fixtures';

// Every journey runs against the synthetic API; nothing reaches a real factory.
test.beforeEach(async ({ page }) => {
  await mockFactoryApi(page);
});

test('phase configuration rejects malformed YAML without launching work', async ({ page }) => {
  const effects: string[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST' && new URL(request.url()).pathname.endsWith('/work'))
      effects.push(request.url());
  });
  await page.goto('/');
  await page
    .getByRole('button', { name: /New run/ })
    .first()
    .click();
  await page.getByRole('button', { name: /Flow & limits/ }).click();
  await expect(page.getByRole('group', { name: 'Flow configuration' })).toBeVisible();
  await page.getByText('Import YAML configuration', { exact: true }).click();
  await page.getByLabel('Flow YAML').fill('version: 1\nexecute: arbitrary-command');
  await page.getByRole('button', { name: 'Apply configuration' }).click();
  await expect(page.getByRole('alert')).toContainText('Invalid YAML configuration');
  expect(effects).toEqual([]);
  await page.screenshot({ path: `../work/flow-${test.info().project.name}.png`, fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('Config Access lists paired browsers and revokes another one', async ({ page }) => {
  const deletes: string[] = [];
  const browsers = [
    {
      id: '0b0e3f0a-1111-4222-8333-444455556666',
      client: 'Chrome on Windows',
      current: true,
      created_at: '2026-11-01T09:00:00Z',
      last_used_at: '2026-11-10T09:00:00Z',
      expires_at: '2026-12-10T09:00:00Z',
    },
    {
      id: '1c1f4a1b-2222-4333-8444-555566667777',
      client: 'Safari on macOS',
      current: false,
      created_at: '2026-10-20T09:00:00Z',
      last_used_at: '2026-10-28T09:00:00Z',
      expires_at: '2026-11-27T09:00:00Z',
    },
  ];
  await page.route('**/api/v1/panel/browsers**', async (route) => {
    if (route.request().method() === 'DELETE') {
      const id = new URL(route.request().url()).pathname.split('/').at(-1)!;
      deletes.push(id);
      expect(route.request().headers()['x-csrf-token']).toBe('synthetic-browser-csrf');
      browsers.splice(
        browsers.findIndex((item) => item.id === id),
        1,
      );
      await route.fulfill({ status: 204 });
      return;
    }
    await route.fulfill({ json: { browsers, lifetime_days: 30 } });
  });
  await page.goto('/config?section=access');
  const list = page.getByRole('list', { name: 'Paired browsers' });
  await expect(list).toContainText('Chrome on Windows');
  await expect(list).toContainText('This browser');
  await expect(page.getByText(/signs out after 30 days without use/)).toBeVisible();
  await expect(page.getByRole('button', { name: /^Revoke Chrome/ })).toHaveCount(0);
  await page.screenshot({ path: `../work/config-access-${test.info().project.name}.png`, fullPage: true });
  await page.getByRole('button', { name: /^Revoke Safari/ }).click();
  await expect(list).not.toContainText('Safari on macOS');
  expect(deletes).toEqual(['1c1f4a1b-2222-4333-8444-555566667777']);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
