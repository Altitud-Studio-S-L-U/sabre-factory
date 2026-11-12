import { test, expect } from '@playwright/test';
import { captureSource } from './fixtures';
import { factoryConfiguration } from '../src/test/factoryConfigurationFixture';
import type { DelegationCreate, DelegationGrant } from '../src/api';

test('connection action links open the registered setup surface without saving', async ({ page }) => {
  const writes: string[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST') writes.push(request.url());
  });
  await page.goto('/tools?connection=github.read');
  await expect(page.getByRole('button', { name: 'Credentials', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(page.getByText(/Opening this page does not save credentials/)).toBeVisible();
  await page.goto('/tools?setup=mcp');
  await expect(page.getByRole('dialog', { name: 'Add MCP server' })).toBeVisible();
  expect(writes).toEqual([]);
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
  await page.getByRole('button', { name: 'External · MCP / A2A' }).click();
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
  await page.getByRole('button', { name: 'External · MCP / A2A' }).click();
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
  await expect(page.getByRole('group', { name: 'Flow configuration' })).toBeVisible();
  await page.getByText('Import YAML configuration', { exact: true }).click();
  await page.getByLabel('Flow YAML').fill('version: 1\nexecute: arbitrary-command');
  await page.getByRole('button', { name: 'Apply configuration' }).click();
  await expect(page.getByRole('alert')).toContainText('Invalid YAML configuration');
  expect(effects).toEqual([]);
  await page.screenshot({ path: `../work/flow-${test.info().project.name}.png`, fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('failed notifications require explicit recovery and show pending after retry', async ({ page }) => {
  await page.goto('/integrations');
  await page.getByRole('button', { name: 'Refresh deliveries' }).click();
  const deliveries = page.getByRole('region', { name: 'Delivery notifications' });
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
  await page.goto('/integrations');
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

test('five console sections keep inspection compact and modal drafts keyboard accessible', async ({
  page,
}) => {
  const mutations: string[] = [];
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('request', (request) => {
    if (['POST', 'PUT', 'DELETE'].includes(request.method())) mutations.push(new URL(request.url()).pathname);
  });
  let saved = factoryConfiguration();
  await page.route('**/api/v1/configuration**', async (route) => {
    const method = route.request().method();
    if (method === 'GET') {
      await route.fulfill({ json: saved });
      return;
    }
    const body = route.request().postDataJSON() as { document: string; expected_revision?: number };
    if (body.document.includes('unknown_capability')) {
      await route.fulfill({
        json: {
          version: 1,
          valid: false,
          configuration: null,
          yaml: null,
          safe_diff: [],
          diagnostics: [
            {
              path: 'unknown_capability',
              message: 'Unknown capability rejected by the synthetic validation fixture',
            },
          ],
        },
      });
      return;
    }
    const next = JSON.parse(body.document) as typeof saved.configuration;
    if (method === 'POST') {
      await route.fulfill({
        json: {
          version: 1,
          valid: true,
          configuration: next,
          yaml: JSON.stringify(next, null, 2),
          safe_diff: [
            {
              path: 'models.default.name',
              before: JSON.stringify(saved.configuration.models.default.name),
              after: JSON.stringify(next.models.default.name),
            },
          ],
          diagnostics: [],
        },
      });
      return;
    }
    expect(body.expected_revision).toBe(saved.revision);
    saved = {
      ...saved,
      revision: saved.revision + 1,
      configuration: next,
      yaml: JSON.stringify(next, null, 2),
    };
    await route.fulfill({ json: saved });
  });
  await page.goto('/work');
  const navigation = page.getByRole('navigation', { name: 'Main navigation' });
  await expect(navigation.getByRole('link')).toHaveCount(5);
  await expect(page.getByRole('heading', { level: 1, name: 'Runs' })).toBeVisible();
  await captureSource(page, 'runs');
  await navigation.getByRole('link', { name: 'Agents', exact: true }).click();
  await expect(
    page.getByRole('complementary', { name: 'Local specialists' }).getByRole('button'),
  ).toHaveCount(7);
  await page.getByRole('tab', { name: 'Chain', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'architecture', exact: true })).toBeVisible();
  await page.getByRole('tab', { name: 'Chain', exact: true }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('tab', { name: 'Instructions & skills' })).toBeFocused();
  await page.getByRole('button', { name: 'Edit draft', exact: true }).click();
  const agentDialog = page.getByRole('dialog', { name: 'Edit Developer draft' });
  await expect(agentDialog).toBeVisible();
  await agentDialog
    .getByRole('textbox', { name: 'Instructions', exact: true })
    .fill('Synthetic keyboard review. Preserve all source evidence.');
  for (let index = 0; index < 20; index++) {
    await page.keyboard.press('Tab');
    expect(await page.evaluate(() => document.activeElement?.closest('dialog')?.open)).toBe(true);
  }
  await page.keyboard.press('Escape');
  await expect(agentDialog.getByText('Discard your unsaved changes?')).toBeVisible();
  await agentDialog.getByRole('button', { name: 'Keep editing' }).click();
  await agentDialog.getByRole('button', { name: 'Close Edit Developer draft' }).click();
  await agentDialog.getByRole('button', { name: 'Discard changes' }).click();
  await expect(agentDialog).not.toBeVisible();
  await expect(page.getByRole('button', { name: 'Edit draft', exact: true })).toBeFocused();
  await captureSource(page, 'agents');
  await navigation.getByRole('link', { name: 'Tools', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'GitHub · repositories', exact: true })).toBeVisible();
  await captureSource(page, 'tools');
  await page.getByRole('button', { name: 'Add MCP connection' }).click();
  const mcpDialog = page.getByRole('dialog', { name: 'Add MCP server' });
  await mcpDialog.getByLabel('Connection name').fill('synthetic-docs');
  await mcpDialog.getByLabel('Endpoint MCP').fill('https://tools.example.com/mcp');
  await page.keyboard.press('Escape');
  await expect(mcpDialog.getByText('Discard your unsaved changes?')).toBeVisible();
  await mcpDialog.getByRole('button', { name: 'Discard changes' }).click();
  await navigation.getByRole('link', { name: 'Memory', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'No approved knowledge' })).toBeVisible();
  await page.getByRole('button', { name: 'Sources', exact: true }).click();
  await expect(
    page.getByText('No source context is recorded for this project in the available history.'),
  ).toBeVisible();
  await captureSource(page, 'memory');
  await navigation.getByRole('link', { name: 'Config', exact: true }).click();
  await page.getByRole('button', { name: '02 · Choose model' }).click();
  await page.getByLabel('Model identifier').fill('synthetic-console-model');
  await captureSource(page, 'config');
  await page.getByRole('button', { name: 'YAML / JSON' }).click();
  const configDocument = page.getByLabel('Configuration document');
  const valid = await configDocument.inputValue();
  await configDocument.fill(`${valid.slice(0, -1)},"unknown_capability":true}`);
  await page.getByRole('button', { name: 'Validate & preview' }).click();
  await expect(page.getByRole('alert')).toContainText('Unknown capability rejected');
  await expect(page.getByRole('button', { name: 'Download document' })).toBeDisabled();
  await configDocument.fill(valid);
  await page.getByRole('button', { name: 'Validate & preview' }).click();
  await expect(page.getByText('Schema validated')).toBeVisible();
  await expect(page.getByRole('cell', { name: 'models.default.name' })).toBeVisible();
  await page.getByLabel('I approve the listed model data destinations for this configuration.').check();
  await page.getByRole('button', { name: 'Save configuration' }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Configuration saved for future runs' }),
  ).toBeVisible();
  await captureSource(page, 'config-contract');
  expect(mutations.filter((path) => path === '/api/v1/configuration')).toHaveLength(1);
  expect(
    mutations.some(
      (path) => path.endsWith('/work') || path.includes('/mcp-connections/') || path.includes('/agents/'),
    ),
  ).toBe(false);
  expect(pageErrors).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('disconnection preserves the catalog and disables changes until explicit recovery', async ({ page }) => {
  let unavailable = false;
  await page.route('**/api/v1/status', async (route) => {
    if (unavailable) await route.fulfill({ status: 503, json: { message: 'Synthetic service outage' } });
    else await route.fallback();
  });
  await page.goto('/tools');
  await expect(page.getByRole('heading', { name: 'GitHub · repositories', exact: true })).toBeVisible();
  unavailable = true;
  await page.getByRole('button', { name: 'Refresh data', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Data could not be refreshed' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'GitHub · repositories', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add MCP connection' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Disable connection' })).toBeDisabled();
  await captureSource(page, 'tools-disconnected');
  unavailable = false;
  await page.getByRole('button', { name: 'Refresh data', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Add MCP connection' })).toBeEnabled();
  await expect(page.getByRole('alert').filter({ hasText: 'Data could not be refreshed' })).toHaveCount(0);
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
