import { test, expect } from '@playwright/test';
import { mockFactoryApi } from './fixtures';

test.beforeEach(async ({ page }) => {
  await mockFactoryApi(page);
});

test('connection action links open the registered setup surface without saving', async ({ page }) => {
  const writes: string[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST') writes.push(request.url());
  });
  await page.goto('/tools?connection=github.read');
  await expect(page.getByRole('tab', { name: 'GitHub', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  const details = page.getByRole('group', { name: 'GitHub · read repositories details' });
  await expect(details.getByRole('region', { name: 'Stored credential' })).toBeVisible();
  await expect(page.getByRole('group', { name: 'GitHub · draft pull requests details' })).toHaveCount(0);
  await expect(page.getByText(/Opening this page does not save credentials/)).toBeVisible();
  await page.goto('/tools?connection=mcp.docs');
  await expect(page.getByRole('tab', { name: /^MCP servers/ })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('group', { name: 'MCP · docs details' })).toBeVisible();
  await page.goto('/tools?setup=mcp');
  await expect(page.getByRole('tab', { name: /^MCP servers/ })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('dialog', { name: 'Add MCP server' })).toBeVisible();
  expect(writes).toEqual([]);
});

test('each service has its own tab, kept in the address across a reload', async ({ page }) => {
  await page.goto('/tools');
  await expect(page.getByRole('tab', { name: 'GitHub', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(
    page.getByRole('heading', { name: 'GitHub · draft pull requests', exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('heading', { name: 'MCP · docs', exact: true })).toHaveCount(0);
  await page.getByRole('tab', { name: /^MCP servers/ }).click();
  await expect(page).toHaveURL(/\/tools\?tab=mcp$/);
  await expect(page.getByRole('heading', { name: 'MCP · docs', exact: true })).toBeVisible();
  await expect(page.getByText('https://tools.example.com/mcp')).toBeVisible();
  await page.reload();
  await expect(page.getByRole('tab', { name: /^MCP servers/ })).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('tab', { name: /^Built-in tools/ }).click();
  await expect(page.getByRole('heading', { name: 'read_source', exact: true })).toBeVisible();
  await page.getByRole('tab', { name: 'Notifications', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Slack', exact: true })).toBeVisible();
  await page.getByRole('tab', { name: 'GitHub', exact: true }).click();
  await expect(page).toHaveURL(/\/tools$/);
});

test('adding a token opens the write-only editor for that connection', async ({ page }) => {
  const writes: string[] = [];
  page.on('request', (request) => {
    if (request.method() !== 'GET') writes.push(request.url());
  });
  await page.route('**/api/v1/secret-targets', (route) =>
    route.fulfill({
      json: [
        { id: 'github.read', label: 'GitHub · repository read' },
        { id: 'github.publish', label: 'GitHub · branch and draft PR' },
      ],
    }),
  );
  await page.goto('/tools');
  await page.getByRole('button', { name: 'Add token for GitHub · read repositories' }).click();
  const editor = page.getByRole('dialog', { name: 'Save credential' });
  await expect(editor.getByLabel('Credential destination')).toHaveValue('github.read');
  await expect(editor.getByLabel('New credential value')).toHaveValue('');
  await page.keyboard.press('Escape');
  await expect(editor).not.toBeVisible();
  await expect(page.getByRole('group', { name: 'GitHub · read repositories details' })).toBeVisible();
  expect(writes).toEqual([]);
});

test('failed notifications require explicit recovery and show pending after retry', async ({ page }) => {
  await page.goto('/tools?tab=notifications');
  const deliveries = page.getByRole('region', { name: 'Delivery notifications' });
  // The log loads with its tab; an explicit refresh reads it again.
  await expect(deliveries.getByRole('cell', { name: 'HTTP_503' })).toBeVisible();
  await page.getByRole('button', { name: 'Refresh deliveries' }).click();
  await expect(deliveries.getByRole('cell', { name: 'HTTP_503' })).toBeVisible();
  await deliveries.getByRole('button', { name: 'Retry delivery' }).click();
  await expect(deliveries.getByRole('cell', { name: 'pending', exact: true })).toBeVisible();
  await expect(deliveries.getByRole('button', { name: 'Retry delivery' })).toHaveCount(0);
});

test('new repository flow requires explicit authorization and submits selected limits', async ({ page }) => {
  let submitted: Record<string, unknown> | undefined;
  await page.route('**/api/v1/create-flows', async (route) => {
    submitted = route.request().postDataJSON() as Record<string, unknown>;
    await route.fulfill({
      status: 202,
      json: {
        id: 'synthetic-proposal',
        request: submitted.repository,
        status: 'approved',
        request_digest: 'a'.repeat(64),
        revision: 1,
        created_at: '2026-11-10T10:00:00Z',
        updated_at: '2026-11-10T10:00:00Z',
        approved_at: '2026-11-10T10:00:00Z',
        started_at: null,
        receipt: null,
        candidate: null,
        error_code: null,
      },
    });
  });
  await page.goto('/tools');
  await page.getByText('Create a repository and launch its flow', { exact: true }).click();
  await page.getByLabel('Repository owner', { exact: true }).fill('example');
  await page.getByLabel('New repository name').fill('synthetic-project');
  await page.getByLabel('New project objective').fill('Build the synthetic project');
  await page.getByLabel('New project acceptance criteria').fill('Registered checks pass');
  await page.getByLabel('Model call limit').fill('12');
  await page.getByRole('button', { name: 'Authorize and launch create flow' }).click();
  expect(submitted).toBeUndefined();
  await page.getByLabel('I authorize creation with these details and execution within these limits.').check();
  await page.getByRole('button', { name: 'Authorize and launch create flow' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Launch accepted' })).toBeVisible();
  expect(submitted).toMatchObject({
    version: 1,
    authorize_repository_creation: true,
    repository: { owner: 'example', name: 'synthetic-project', initialize: true, visibility: 'private' },
    budget: { max_calls: 12, max_cost_usd: 0 },
    flow_config: { repair_cycles: 2 },
  });
});
