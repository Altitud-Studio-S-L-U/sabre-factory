import { test, expect } from '@playwright/test';
import { mockFactoryApi, syntheticRun } from './fixtures';
import type { OwnerConfirmation } from '../src/api';

// Every journey runs against the synthetic API; nothing reaches a real factory.
test.beforeEach(async ({ page }) => {
  await mockFactoryApi(page);
});

function request(changes: Partial<OwnerConfirmation> = {}): OwnerConfirmation {
  return {
    version: 1,
    id: 'confirmation-1',
    kind: 'budget.tokens',
    work_id: 'synthetic-run',
    source: 'mcp',
    state: 'pending',
    summary: 'Raise the token limit from 100,000 to 250,000',
    request: { expected_revision: 1, expected_max_tokens: 100000, max_tokens: 250000 },
    request_digest: 'a'.repeat(64),
    created_at: '2026-11-12T09:00:00Z',
    expires_at: '2026-11-13T09:00:00Z',
    decided_at: null,
    error_code: null,
    error_message: null,
    ...changes,
  };
}

test('a request filed over MCP is signalled on every section and decided in the Supervisor inbox', async ({
  page,
}) => {
  const order = { ...syntheticRun(), status: 'blocked', error_code: 'BUDGET_EXHAUSTED' };
  let items = [
    request(),
    request({
      id: 'confirmation-2',
      kind: 'security.exception',
      summary: 'Accept security finding finding-1 until 2026-12-01',
      request: { fingerprint: 'finding-1', justification: 'Owner accepts temporary exposure' },
      request_digest: 'b'.repeat(64),
    }),
  ];
  const decisions: { path: string; body: unknown }[] = [];
  await page.route('**/api/v1/work**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/work')) return route.fulfill({ json: [order] });
    if (path.endsWith('/work/synthetic-run')) return route.fulfill({ json: order });
    await route.fallback();
  });
  await page.route('**/api/v1/confirmations**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (route.request().method() === 'GET')
      return route.fulfill({
        json: { version: 1, pending: items.filter((item) => item.state === 'pending').length, items },
      });
    decisions.push({ path, body: route.request().postDataJSON() });
    const [, id, action] = /confirmations\/([^/]+)\/(confirm|reject)$/.exec(path)!;
    const state = action === 'confirm' ? 'applied' : 'rejected';
    items = items.map((item) => (item.id === id ? { ...item, state } : item));
    await route.fulfill({ json: items.find((item) => item.id === id) });
  });

  await page.goto('/memory');
  const launcher = page.getByRole('button', { name: 'Supervisor', exact: true });
  // Announced without moving the page: a toast, and the launcher says how much is waiting.
  await expect(page.getByTestId('attention-toast')).toHaveCount(2);
  await expect(launcher).toHaveAccessibleDescription('3 items need you');
  await expect(page.getByTestId('pending-confirmation')).toHaveCount(0);
  const waiting = page.getByRole('region', { name: '2 requests are waiting for your confirmation' });
  await page.getByRole('button', { name: 'Review' }).first().click();
  await expect(waiting).toBeVisible();
  await expect(waiting.getByTestId('pending-confirmation')).toHaveCount(2);
  expect(decisions).toEqual([]);

  // A reload on another section: still signalled, not announced a second time.
  await page.goto('/runs');
  await expect(launcher).toHaveAccessibleDescription('3 items need you');
  await expect(page.getByTestId('attention-toast')).toHaveCount(0);
  await launcher.click();
  const budget = waiting.getByTestId('pending-confirmation').filter({ hasText: 'Raise the token limit' });
  await expect(budget.getByRole('link', { name: 'Correct the synthetic example' })).toHaveAttribute(
    'href',
    '/runs/synthetic-run',
  );
  await budget.getByText('Exact request').click();
  await expect(budget.getByText('250,000', { exact: true })).toBeVisible();
  // SABRE_GALLERY=<label> keeps a capture of the open request next to the section gallery.
  if (process.env.SABRE_GALLERY)
    await page.screenshot({
      path: `../work/gallery/${process.env.SABRE_GALLERY}/confirmations-${test.info().project.name}.png`,
      scale: 'css',
    });
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);

  await page
    .getByRole('button', { name: 'Reject: Accept security finding finding-1 until 2026-12-01' })
    .click();
  await expect(page.getByRole('status').filter({ hasText: 'Nothing changed.' })).toBeVisible();
  await expect(
    page.getByRole('region', { name: 'A request is waiting for your confirmation' }),
  ).toBeVisible();

  await page.getByRole('button', { name: 'Confirm: Raise the token limit from 100,000 to 250,000' }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Applied: Raise the token limit from 100,000 to 250,000.' }),
  ).toBeVisible();
  await expect(page.getByTestId('pending-confirmation')).toHaveCount(0);
  expect(decisions).toEqual([
    {
      path: '/api/v1/confirmations/confirmation-2/reject',
      body: { version: 1, request_digest: 'b'.repeat(64) },
    },
    {
      path: '/api/v1/confirmations/confirmation-1/confirm',
      body: { version: 1, request_digest: 'a'.repeat(64) },
    },
  ]);
  await page.getByRole('button', { name: 'Dismiss' }).click();
  await expect(page.getByText(/^Applied:/)).toHaveCount(0);
});
