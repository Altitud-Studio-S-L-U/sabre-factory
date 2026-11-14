import { test, expect, type Page } from '@playwright/test';
import { mockFactoryApi } from './fixtures';
import { repositoryRead, repositoryStatement } from '../src/test/memoryFixture';

/** A project whose repository has not been read; one read indexes it and proposes two statements. */
async function memoryService(page: Page) {
  const writes: { path: string; body: unknown }[] = [];
  let read = false;
  let statements = [
    repositoryStatement(),
    repositoryStatement({
      id: 'r32',
      content:
        'package.json › scripts\nScripts this manifest declares; none was run to confirm it.\n- test: vitest run',
      citations: ['package.json#L6'],
      proposed_by: { channel: 'repository', role: 'manifest', work_id: null },
    }),
  ];
  await page.route('**/api/v1/projects/*/ingestion', async (route) => {
    if (route.request().method() === 'POST') {
      writes.push({ path: '/ingestion', body: route.request().postDataJSON() });
      read = true;
      await route.fulfill({
        status: 202,
        json: {
          ...repositoryRead().jobs[0],
          state: 'queued',
          source_commit: null,
          finished_at: null,
          imported: null,
        },
      });
      return;
    }
    await route.fulfill({
      json: read
        ? repositoryRead({ proposed: 2 })
        : { version: 1, project_id: 'synthetic-project', jobs: [], latest: null },
    });
  });
  await page.route('**/api/v1/projects/*/memory/review', (route) =>
    route.fulfill({
      json: {
        commit: read ? statements[0]?.source_commit : null,
        truncated: false,
        stale: [],
        pending: read
          ? statements.filter((item) => item.state === 'pending').map((item) => ({ item, overlaps: [] }))
          : [],
      },
    }),
  );
  await page.route('**/api/v1/memory?*', (route) => route.fulfill({ json: read ? statements : [] }));
  await page.route('**/api/v1/memory/*/approve', async (route) => {
    const id = new URL(route.request().url()).pathname.split('/').at(-2)!;
    writes.push({ path: `/memory/${id}/approve`, body: route.request().postDataJSON() });
    statements = statements.map((item) =>
      item.id === id
        ? { ...item, active: true, state: 'active' as const, approved_at: '2026-11-14T10:00:00Z' }
        : item,
    );
    await route.fulfill({ json: statements.find((item) => item.id === id) });
  });
  await page.route('**/api/v1/memory', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    writes.push({ path: '/memory', body: route.request().postDataJSON() });
    await route.fulfill({
      status: 201,
      json: repositoryStatement({ id: 'm40', content: 'Prices are stored in cents.' }),
    });
  });
  return writes;
}

test.beforeEach(async ({ page }) => {
  await mockFactoryApi(page);
});

test('reading the repository fills the review queue, and the owner approves and adds knowledge', async ({
  page,
}) => {
  const writes = await memoryService(page);
  await page.goto('/memory');
  const status = page.getByRole('region', { name: 'Memory status' });
  // An empty memory names its cause and the one action that fills it.
  await expect(status).toContainText(
    'has not been read yet, so the factory knows nothing about this project',
  );
  await status.getByRole('button', { name: 'Read the repository' }).click();
  await expect(status.getByRole('button', { name: 'Reading…' })).toBeDisabled();
  // The console notices the finished read by itself and shows what it proposed.
  await expect(status.getByRole('button', { name: 'Review 2 proposals' })).toBeVisible({ timeout: 15_000 });
  await expect(status).toContainText('0 approved records · 2 waiting for your review');
  await expect(status).toContainText('Last read at 5be10d70');
  await expect(status).toContainText('2 proposed.');
  expect(writes[0]).toMatchObject({ path: '/ingestion', body: { version: 1 } });

  await status.getByRole('button', { name: 'Review 2 proposals' }).click();
  await expect(page.getByRole('tab', { name: 'Review queue', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  const comparison = page.getByRole('region', { name: 'Proposal comparison' });
  await expect(comparison.getByRole('heading', { name: 'AGENTS.md › Verify' })).toBeVisible();
  await expect(comparison).toContainText(
    'Repository · instructions · indexed commit 5be10d70 · cites AGENTS.md#L12',
  );
  await comparison.getByRole('button', { name: 'Approve', exact: true }).click();
  await expect(status).toContainText('1 approved record · 1 waiting for your review');
  expect(writes.at(-1)).toEqual({ path: '/memory/r31/approve', body: {} });

  // The owner's own knowledge is recorded against the commit just read: no run identifier to type.
  await page.getByRole('button', { name: 'Propose memory' }).click();
  const dialog = page.getByRole('dialog', { name: 'Propose project memory' });
  await expect(dialog.getByLabel('Indexed commit')).toHaveValue('5be10d7'.padEnd(40, '0'));
  await dialog.getByLabel('Content').fill('Prices are stored in cents.');
  await dialog.getByLabel('Cited files').fill('src/pricing/catalog.py#L3');
  await dialog.getByRole('button', { name: 'Save proposal' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('status').filter({ hasText: 'Proposal recorded' })).toBeVisible();
  expect(writes.at(-1)).toEqual({
    path: '/memory',
    body: {
      project_id: 'synthetic-project',
      kind: 'lesson',
      content: 'Prices are stored in cents.',
      source_commit: '5be10d7'.padEnd(40, '0'),
      scope: 'project',
      citations: ['src/pricing/catalog.py#L3'],
    },
  });
});
