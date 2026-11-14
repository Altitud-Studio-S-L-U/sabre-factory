import { test, expect, type Page } from '@playwright/test';
import { githubConnection, mockFactoryApi, syntheticRun } from './fixtures';

type Project = Record<string, unknown> & { revision: number; archived_at: string | null };

/** The synthetic project with the state a real service would keep across requests. */
async function projectService(page: Page) {
  const writes: { method: string; path: string; body: unknown }[] = [];
  let project: Project = {
    id: 'synthetic-project',
    name: 'Example project',
    repository: 'https://github.com/example/demo',
    profile: 'node',
    default_branch: 'main',
    gate_commands: [['npm', 'test']],
    allowed_mcp_servers: [],
    approved_baseline: [],
    browser_preview: null,
    revision: 0,
    archived_at: null,
    created_at: '2026-01-01T00:00:00Z',
  };
  await page.route(
    /\/api\/v1\/projects(\/synthetic-project(\/(archive|restore))?)?(\?.*)?$/,
    async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (request.method() === 'GET') {
        const all = url.searchParams.get('include') === 'archived';
        await route.fulfill({ json: all || !project.archived_at ? [project] : [] });
        return;
      }
      const body = request.postDataJSON() as { expected_revision: number } & Record<string, unknown>;
      writes.push({ method: request.method(), path: url.pathname.replace('/api/v1', ''), body });
      if (body.expected_revision !== project.revision) {
        await route.fulfill({
          status: 409,
          json: { code: 'PROJECT_CHANGED', message: 'The project changed; refresh it before continuing' },
        });
        return;
      }
      const fields = Object.fromEntries(Object.entries(body).filter(([key]) => key !== 'expected_revision'));
      project = {
        ...project,
        ...(request.method() === 'PUT' ? fields : {}),
        archived_at: url.pathname.endsWith('/archive')
          ? '2026-11-14T10:00:00Z'
          : url.pathname.endsWith('/restore')
            ? null
            : project.archived_at,
        revision: project.revision + 1,
      };
      await route.fulfill({ json: project });
    },
  );
  return writes;
}

test.beforeEach(async ({ page }) => {
  await mockFactoryApi(page);
});

test('a project is edited, archived out of every list and restored', async ({ page }) => {
  const writes = await projectService(page);
  // One run of that project, so the run list has something to lose and to bring back.
  await page.route('**/api/v1/work', (route) => route.fulfill({ json: [syntheticRun()] }));
  await page.goto('/projects');
  await expect(page.getByRole('heading', { name: 'Example project', exact: true })).toBeVisible();
  await expect(page.getByText('1 configured check')).toBeVisible();
  await expect(page.getByText('1 runs')).toBeVisible();

  await page.getByRole('button', { name: 'Edit Example project' }).click();
  const editor = page.getByRole('dialog', { name: 'Edit Example project' });
  await expect(editor.getByLabel('Repository')).toHaveValue('https://github.com/example/demo');
  await expect(editor.getByLabel('Repository')).not.toBeEditable();
  await editor.getByLabel('Delivery checks').fill('["npm","test"]\n["npm","run","typecheck"]');
  // Unsaved edits are not lost to a stray Escape.
  await page.keyboard.press('Escape');
  await expect(editor.getByText('Discard your unsaved changes?')).toBeVisible();
  await editor.getByRole('button', { name: 'Keep editing' }).click();
  await editor.getByRole('button', { name: 'Save changes' }).click();
  await expect(editor).not.toBeVisible();
  await expect(page.getByText('Example project saved.')).toBeVisible();
  await expect(page.getByText('2 configured checks')).toBeVisible();
  expect(writes).toEqual([
    {
      method: 'PUT',
      path: '/projects/synthetic-project',
      body: {
        expected_revision: 0,
        name: 'Example project',
        profile: 'node',
        default_branch: 'main',
        gate_commands: [
          ['npm', 'test'],
          ['npm', 'run', 'typecheck'],
        ],
        browser_preview: null,
      },
    },
  ]);

  await page.getByRole('button', { name: 'Archive Example project' }).click();
  const confirmation = page.getByRole('dialog', { name: 'Archive Example project' });
  await expect(confirmation.getByText(/Its runs, memory and evidence are kept/)).toBeVisible();
  expect(writes).toHaveLength(1);
  await confirmation.getByRole('button', { name: 'Archive project' }).click();
  await expect(page.getByRole('heading', { name: 'No active project' })).toBeVisible();
  expect(writes[1]).toEqual({
    method: 'POST',
    path: '/projects/synthetic-project/archive',
    body: { expected_revision: 1 },
  });

  // Its run leaves the list and comes back when the archived project is chosen.
  await page.goto('/runs');
  await expect(page.getByRole('heading', { name: 'Runs', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: /Correct the synthetic example/ })).toHaveCount(0);
  await page.getByRole('combobox', { name: 'Project' }).selectOption({ label: 'Example project (archived)' });
  await expect(page.getByRole('link', { name: /Correct the synthetic example/ }).first()).toBeVisible();
  // A new run cannot choose it.
  await page
    .getByRole('button', { name: /New run/ })
    .first()
    .click();
  await expect(page.getByRole('dialog', { name: 'New run', exact: true })).toBeVisible();
  await expect(
    page.getByRole('dialog', { name: 'New run', exact: true }).getByText('Example project'),
  ).toHaveCount(0);

  await page.goto('/projects');
  await page.getByRole('checkbox', { name: 'Show archived (1)' }).check();
  const archived = page.getByRole('region', { name: 'Archived' });
  await expect(archived.getByRole('heading', { name: 'Example project' })).toBeVisible();
  await archived.getByRole('button', { name: 'Restore Example project' }).click();
  await expect(page.getByText('Example project restored.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Edit Example project' })).toBeVisible();
  expect(writes[2]).toEqual({
    method: 'POST',
    path: '/projects/synthetic-project/restore',
    body: { expected_revision: 2 },
  });
  expect(writes).toHaveLength(3);
});

test('a refused archive names the run that holds the project and changes nothing', async ({ page }) => {
  await page.route('**/api/v1/projects/synthetic-project/archive', (route) =>
    route.fulfill({
      status: 409,
      json: {
        code: 'PROJECT_HAS_OPEN_RUNS',
        message: 'Run 92d64ad6 is not finished; cancel it or let it finish before archiving',
      },
    }),
  );
  await page.goto('/projects');
  await page.getByRole('button', { name: 'Archive Example project' }).click();
  const confirmation = page.getByRole('dialog', { name: 'Archive Example project' });
  await confirmation.getByRole('button', { name: 'Archive project' }).click();
  await expect(confirmation.getByRole('alert')).toHaveText(/Run 92d64ad6 is not finished/);
  await confirmation.getByRole('button', { name: 'Back' }).click();
  await expect(page.getByRole('heading', { name: 'Example project', exact: true })).toBeVisible();
  // Still only the project that was archived before: the refused one did not join it.
  await expect(page.getByRole('checkbox', { name: 'Show archived (1)' })).toBeVisible();
});

test('a project is added from one place: from GitHub, by address or as a new repository', async ({
  page,
}) => {
  await mockFactoryApi(page);
  await page.goto('/projects');
  await page.getByRole('button', { name: '+ Add project' }).click();
  const dialog = page.getByRole('dialog', { name: 'Add project' });
  const source = dialog.getByRole('group', { name: 'Where the project comes from' });
  await expect(source.getByRole('button')).toHaveText(['From GitHub', 'By address', 'New repository']);
  // With no app installed the address form comes first, and its draft survives a look at the other sources.
  await expect(source.getByRole('button', { name: 'By address' })).toHaveAttribute('aria-pressed', 'true');
  await dialog.getByLabel('Project name').fill('Draft name');
  // The sources differ in height: the choice stays where the pointer left it.
  const top = async () => Math.round((await source.boundingBox())?.y ?? -1);
  const place = await top();
  await source.getByRole('button', { name: 'From GitHub' }).click();
  await expect(dialog.getByRole('button', { name: 'Search repositories' })).toBeVisible();
  expect(await top()).toBe(place);
  await source.getByRole('button', { name: 'New repository' }).click();
  await expect(dialog.getByRole('button', { name: 'Propose repository' })).toBeVisible();
  expect(await top()).toBe(place);
  await source.getByRole('button', { name: 'By address' }).click();
  await expect(dialog.getByLabel('Project name')).toHaveValue('Draft name');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('with the GitHub App installed, adding a project starts from the repositories it reaches', async ({
  page,
}) => {
  await mockFactoryApi(page);
  await page.route('**/api/v1/github/connection', (route) =>
    route.fulfill({ json: githubConnection('connected') }),
  );
  await page.goto('/projects');
  await page.getByRole('button', { name: '+ Add project' }).click();
  const dialog = page.getByRole('dialog', { name: 'Add project' });
  await expect(
    dialog
      .getByRole('group', { name: 'Where the project comes from' })
      .getByRole('button', { name: 'From GitHub' }),
  ).toHaveAttribute('aria-pressed', 'true');
  await expect(dialog.getByText(/2 repositories through the GitHub\s+connection/)).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Import octo-fixture/widgets' })).toBeEnabled();
  await expect(dialog.getByRole('button', { name: 'Search repositories' })).toHaveCount(0);
});
