import { test, expect } from '@playwright/test';
import type { DelegationCreate, DelegationGrant } from '../src/api';
import { mockFactoryApi } from './fixtures';

test.beforeEach(async ({ page }) => {
  await mockFactoryApi(page);
});

test('inbound agent access requires explicit scope and revocation and never restores the one-time credential', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(error.message));
  const requests: DelegationCreate[] = [];
  let grant: DelegationGrant | null = null;
  let revoked = false;
  let writes = 0;
  const token = 'sabre_d_synthetic-browser-secret';
  await page.route('**/api/v1/delegations**', async (route) => {
    if (route.request().method() === 'POST') {
      writes++;
      const body = route.request().postDataJSON() as DelegationCreate;
      requests.push(body);
      const { version, idempotency_key: requestKey, ...limits } = body;
      expect(version).toBe(1);
      expect(requestKey.length).toBeGreaterThanOrEqual(8);
      grant = {
        version: 1,
        id: 'synthetic-browser-grant',
        principal: body.principal,
        data: limits,
        created_at: '2026-11-11T12:00:00Z',
        expires_at: '2099-11-11T13:00:00Z',
        revoked_at: null,
      };
      await route.fulfill({
        json: {
          version: 1,
          id: grant.id,
          principal: grant.principal,
          expires_at: grant.expires_at,
          token,
          recovered: false,
        },
      });
    } else if (route.request().method() === 'DELETE') {
      writes++;
      revoked = true;
      await route.fulfill({
        json: { version: 1, id: grant!.id, revoked: true, revoked_at: '2026-11-11T14:00:00Z' },
      });
    } else
      await route.fulfill({
        json: grant ? [{ ...grant, revoked_at: revoked ? '2026-11-11T14:00:00Z' : null }] : [],
      });
  });
  await page.goto('/agents');
  await page.getByRole('tab', { name: 'External · MCP / A2A' }).click();
  const panel = page.getByRole('region', { name: 'Inbound delegated access' });
  await expect(panel.getByText('No delegated access issued.')).toBeVisible();
  await panel.getByRole('button', { name: 'Issue access' }).click();
  const dialog = page.getByRole('dialog', { name: 'Issue delegated access' });
  const issue = dialog.getByRole('button', { name: 'Issue scoped credential' });
  await expect(issue).toBeDisabled();
  await dialog.getByLabel('External principal').fill('synthetic-browser-partner');
  await dialog.getByRole('checkbox', { name: 'Example project' }).check();
  await dialog.getByRole('checkbox', { name: 'Inspect assigned runs' }).check();
  await expect(issue).toBeDisabled();
  await dialog.getByRole('checkbox', { name: /I authorize/ }).check();
  expect(writes).toBe(0);
  await issue.click();
  const receipt = page.getByRole('dialog', { name: 'Save the delegated credential' });
  const credential = receipt.getByLabel('New delegated credential');
  await expect(credential).toHaveAttribute('type', 'password');
  await expect(credential).toHaveValue(token);
  await receipt.getByRole('button', { name: 'Reveal credential' }).click();
  await expect(credential).toHaveAttribute('type', 'text');
  await page.keyboard.press('Escape');
  await expect(receipt).not.toBeVisible();
  await expect(page.locator(`input[value="${token}"]`)).toHaveCount(0);
  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({
    projects: ['synthetic-project'],
    operations: ['work.query'],
    max_runs: 1,
    max_calls: 10,
    max_tokens: 20000,
    max_cost_usd: 0,
    active_seconds: 600,
    expires_in: 3600,
  });
  await page.getByRole('link', { name: 'Runs', exact: true }).click();
  await page.getByRole('link', { name: 'Agents', exact: true }).click();
  await page.getByRole('tab', { name: 'External · MCP / A2A' }).click();
  await panel.getByRole('button', { name: 'Revoke synthetic-browser-partner' }).click();
  const revoke = page.getByRole('dialog', { name: 'Revoke delegated access?' });
  expect(writes).toBe(1);
  await expect(page.getByLabel('New delegated credential')).toHaveCount(0);
  await revoke.getByRole('button', { name: 'Confirm revocation' }).click();
  await expect(panel.getByText('Revoked', { exact: true })).toBeVisible();
  expect(writes).toBe(2);
  expect(errors).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
