import { test, expect } from '@playwright/test';
import { captureSource, mockFactoryApi, syntheticRun } from './fixtures';

// Every journey runs against the synthetic API; nothing reaches a real factory.
test.beforeEach(async ({ page }) => {
  await mockFactoryApi(page);
});

test('supervisor offers observed connection actions and opens setup from the same page', async ({ page }) => {
  const messageId = 'synthetic-readiness-message';
  const actions = [
    {
      id: 'connect-github-read',
      kind: 'open_tool',
      target: 'github.read',
      label: 'Connect GitHub repositories',
    },
    { id: 'add-mcp-connection', kind: 'open_tools', target: 'mcp', label: 'Add MCP connection' },
  ];
  await page.route('**/api/v1/operator/messages**', (route) =>
    route.fulfill({
      json: new URL(route.request().url()).pathname.endsWith('/tools')
        ? {
            version: 1,
            message_id: messageId,
            available: true,
            checkpoint_id: 'synthetic-readiness-checkpoint',
            truncated: false,
            actions,
            tools: [
              {
                call_id: 'synthetic-readiness-call',
                name: 'get_factory_readiness',
                input: '{}',
                output: JSON.stringify({
                  version: 1,
                  items: [],
                  connections: [
                    {
                      id: 'github.read',
                      enabled: true,
                      credential_configured: false,
                      access: 'Synthetic public-only access',
                    },
                  ],
                  external_tools: [],
                  external_tools_truncated: false,
                  actions,
                }),
                status: 'completed',
                redacted: false,
                truncated: false,
              },
            ],
          }
        : {
            items: [
              {
                version: 1,
                id: messageId,
                work_id: null,
                text: 'Synthetic fixture: inspect GitHub readiness',
                allowed_actions: [],
                state: 'completed',
                reply:
                  'GitHub credentials are missing in this synthetic fixture. Open setup to connect the account.',
                error_code: null,
                created_at: '2026-11-11T10:00:00Z',
              },
            ],
            truncated: false,
          },
    }),
  );
  const writes: string[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST') writes.push(request.url());
  });
  await page.goto('/tools');
  await page.getByRole('button', { name: 'Supervisor', exact: true }).click();
  await page.getByRole('button', { name: 'Expand chat', exact: true }).click();
  const chat = page.getByRole('dialog', { name: 'Supervisor conversation' });
  await expect(chat.getByRole('link', { name: 'Connect GitHub repositories' })).toBeVisible();
  await expect(chat.getByRole('img', { name: /^Supervisor · / })).toBeVisible();
  await captureSource(page, 'supervisor-actions');
  await chat.getByRole('link', { name: 'Connect GitHub repositories' }).click();
  await expect(chat).not.toBeVisible();
  await expect(page).toHaveURL(/\/tools\?connection=github.read/);
  await expect(page.getByRole('tab', { name: 'Credentials', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  expect(writes).toEqual([]);
});

test('supervisor expands, retains per-run context and reveals recorded tools', async ({ page }) => {
  const orders = [
    { ...syntheticRun(), status: 'blocked', error_code: 'BUDGET_EXHAUSTED' },
    { ...syntheticRun(), id: 'synthetic-second', objective: 'Synthetic second run', status: 'failed' },
  ];
  await page.route('**/api/v1/work', (route) => route.fulfill({ json: orders }));
  await page.route('**/api/v1/operator/messages**', (route) =>
    route.fulfill({
      json: new URL(route.request().url()).pathname.endsWith('/tools')
        ? {
            version: 1,
            message_id: 'synthetic-budget-message',
            available: true,
            checkpoint_id: 'synthetic-checkpoint',
            truncated: false,
            tools: [
              {
                call_id: 'synthetic-call',
                name: 'get_work_budget',
                input: '{"work_id":"synthetic-run"}',
                output: '{"measured_tokens":1200}',
                status: 'completed',
                redacted: false,
                truncated: false,
              },
            ],
          }
        : {
            items: [
              {
                version: 1,
                id: 'synthetic-budget-message',
                work_id: null,
                text: 'Read the run budget',
                allowed_actions: [],
                state: 'completed',
                reply: 'Synthetic response: usage is recorded per run.',
                error_code: null,
                created_at: '2026-11-11T10:00:00Z',
              },
            ],
            truncated: false,
          },
    }),
  );
  await page.goto('/runs');
  await page.getByRole('button', { name: 'Supervisor', exact: true }).click();
  const drawer = page.getByRole('region', { name: 'Supervisor conversation' });
  await drawer.getByRole('button', { name: 'Expand chat' }).click();
  const chat = page.getByRole('dialog', { name: 'Supervisor conversation' });
  await expect(chat).toBeVisible();
  await chat.locator('summary').filter({ hasText: 'Recorded tool invocations' }).click();
  await expect(chat.getByText('get_work_budget', { exact: false }).first()).toBeVisible();
  await expect(chat.getByTestId('supervisor-tools')).toHaveAttribute('open', '');
  await chat.getByTestId('supervisor-tool').locator('summary').filter({ hasText: 'get_work_budget' }).click();
  await expect(chat.getByText('{"measured_tokens":1200}', { exact: true })).toBeVisible();
  await captureSource(page, 'supervisor-expanded');
  await chat.locator('summary').filter({ hasText: 'Attention inbox' }).click();
  await expect(chat.getByText('Synthetic second run', { exact: true })).toBeVisible();
  await chat.getByRole('button', { name: 'Discuss run · c-second' }).click();
  await expect(chat.getByRole('combobox', { name: /Conversation context/ })).toHaveValue('synthetic-second');
  await chat.getByRole('textbox', { name: 'Message', exact: true }).fill('Synthetic draft stays in this run');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('region', { name: 'Supervisor conversation' })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toHaveValue(
    'Synthetic draft stays in this run',
  );
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('supervisor persists an owner conversation across navigation and defaults to read-only', async ({
  page,
}) => {
  const requests: Record<string, unknown>[] = [];
  const messages: Record<string, unknown>[] = [];
  await page.route('**/api/v1/operator/messages**', async (route) => {
    if (route.request().method() === 'POST') {
      const body = route.request().postDataJSON() as Record<string, unknown>;
      requests.push(body);
      const message = {
        version: 1,
        id: 'synthetic-owner-message',
        work_id: body.work_id,
        text: body.text,
        allowed_actions: body.allowed_actions,
        state: 'queued',
        reply: null,
        error_code: null,
        created_at: '2026-11-11T10:00:00Z',
      };
      messages.push(message);
      await route.fulfill({ status: 202, json: message });
      return;
    }
    await route.fulfill({ json: { items: messages, truncated: false } });
  });
  await page.goto('/runs');
  await page.getByRole('button', { name: 'Supervisor', exact: true }).click();
  const conversation = page.getByRole('region', { name: 'Supervisor conversation' });
  await conversation
    .getByRole('textbox', { name: 'Message', exact: true })
    .fill('Watch out: preserve the public API');
  await conversation.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(conversation.getByText('Message queued. No action has been confirmed.')).toBeVisible();
  expect(requests[0]).toMatchObject({ version: 1, work_id: null, allowed_actions: [] });
  expect(requests[0]).not.toHaveProperty('principal');
  await conversation.getByRole('button', { name: 'Close supervisor' }).click();
  await page
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('link', { name: 'Agents', exact: true })
    .click();
  await expect(
    page
      .getByRole('complementary', { name: 'Local specialists' })
      .getByRole('button', { name: /Supervisor/ }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Supervisor', exact: true }).click();
  await expect(conversation.getByText('Watch out: preserve the public API', { exact: true })).toBeVisible();
  messages[0] = {
    ...messages[0],
    state: 'completed',
    reply: 'Synthetic reply: the concern is recorded. No run or policy was changed.',
  };
  await expect(
    conversation.getByText('Synthetic reply: the concern is recorded. No run or policy was changed.'),
  ).toBeVisible();
  await page.screenshot({ path: `../work/supervisor-${test.info().project.name}.png`, fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('blocked supervisor message resumes by identity without expanding its original grants', async ({
  page,
}) => {
  let resumed: Record<string, unknown> | undefined;
  let message = {
    version: 1,
    id: 'synthetic-blocked-message',
    work_id: null,
    text: 'Inspect readiness',
    allowed_actions: [],
    state: 'blocked',
    reply: null,
    error_code: 'MODEL_NOT_READY' as string | null,
    created_at: '2026-11-11T10:00:00Z',
  };
  await page.route('**/api/v1/operator/messages**', async (route) => {
    if (route.request().method() === 'POST') {
      expect(new URL(route.request().url()).pathname).toBe(
        '/api/v1/operator/messages/synthetic-blocked-message/resume',
      );
      resumed = route.request().postDataJSON() as Record<string, unknown>;
      message = { ...message, state: 'queued', error_code: null };
      await route.fulfill({ status: 202, json: message });
      return;
    }
    await route.fulfill({ json: { items: [message], truncated: false } });
  });
  await page.goto('/runs');
  await page.getByRole('button', { name: 'Supervisor', exact: true }).click();
  const conversation = page.getByRole('region', { name: 'Supervisor conversation' });
  await conversation.getByRole('button', { name: 'Reconcile and resume message' }).click();
  await expect(conversation.getByText('Message queued. No action has been confirmed.')).toBeVisible();
  expect(resumed).toEqual({ version: 1, expected_error_code: 'MODEL_NOT_READY' });
  expect(message.allowed_actions).toEqual([]);
});

test('the Supervisor launcher never floats over content on wide screens', async ({ page }) => {
  await page.goto('/memory');
  const launcher = page.getByRole('button', { name: 'Supervisor', exact: true });
  await expect(launcher).toBeVisible();
  const inHeader = page.getByRole('banner').getByRole('button', { name: 'Supervisor', exact: true });
  if (test.info().project.name === 'desktop') {
    await expect(inHeader).toBeVisible();
    await launcher.click();
    const conversation = page.getByRole('region', { name: 'Supervisor conversation' });
    await expect(conversation).toBeVisible();
    // The header launcher stays reachable beside the docked panel and closes it.
    await expect(launcher).toHaveAttribute('aria-expanded', 'true');
    await launcher.click();
    await expect(conversation).toBeHidden();
  } else {
    await expect(inHeader).toHaveCount(0);
    const box = await launcher.boundingBox();
    const tabs = await page.getByRole('navigation', { name: 'Main navigation' }).boundingBox();
    expect(box && tabs && box.y + box.height <= tabs.y).toBe(true);
  }
});
