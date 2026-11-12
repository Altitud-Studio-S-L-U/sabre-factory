import { test, expect } from '@playwright/test';
import { captureSource, mockFactoryApi } from './fixtures';
import { factoryConfiguration } from '../src/test/factoryConfigurationFixture';

// Every journey runs against the synthetic API; nothing reaches a real factory.
test.beforeEach(async ({ page }) => {
  await mockFactoryApi(page);
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
