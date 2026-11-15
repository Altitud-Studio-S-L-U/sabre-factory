import { test, expect } from '@playwright/test';
import { addProject, archiveProject, connected, unique, watch } from './fixture';

test('Config lists this browser as paired and reads the configuration the application holds', async ({
  page,
}) => {
  const watched = watch(page);
  await page.goto('/config?section=access');
  await connected(page);
  await expect(page.getByText('This browser', { exact: true })).toBeVisible();
  // The environment page shows what the fixture was started with, not a default of the console.
  const views = page.getByRole('group', { name: 'Configuration views' });
  await views.getByRole('button', { name: 'Environment' }).click();
  await expect(page.getByText('http://127.0.0.1:8001', { exact: true })).toBeVisible();
  await views.getByRole('button', { name: 'History' }).click();
  await expect(page.getByRole('heading', { name: 'Revision history' })).toBeVisible();
  watched.clean();
});

test('a configuration change is validated by the application, saved as a new revision and put back', async ({
  page,
}) => {
  const watched = watch(page);
  await page.goto('/config');
  await connected(page);
  const views = page.getByRole('group', { name: 'Configuration views' });
  const revision = async () =>
    Number(
      (
        await page
          .getByText(/^Revision \d+$/)
          .first()
          .textContent()
      )?.replace(/\D/g, ''),
    );
  const change = async (value: string) => {
    await views.getByRole('button', { name: 'Policies & limits' }).click();
    await page.getByLabel('Repair cycles').fill(value);
    await page.getByRole('button', { name: 'Validate & preview' }).click();
    await expect(page.getByText('Schema validated')).toBeVisible();
    // The list of changes comes from the application, not from the form that was edited.
    await expect(page.getByRole('cell', { name: /repair_cycles/ })).toBeVisible();
    await page.getByLabel('I approve the listed model data destinations for this configuration.').check();
    await page.getByRole('button', { name: 'Save configuration' }).click();
  };

  await views.getByRole('button', { name: 'Policies & limits' }).click();
  const original = await page.getByLabel('Repair cycles').inputValue();
  const changed = original === '1' ? '2' : '1';
  const before = await revision();
  await change(changed);
  await expect.poll(revision).toBe(before + 1);

  // A reload reads the saved revision back from the application.
  await page.reload();
  await connected(page);
  await views.getByRole('button', { name: 'Policies & limits' }).click();
  await expect(page.getByLabel('Repair cycles')).toHaveValue(changed);
  expect(await revision()).toBe(before + 1);

  await change(original);
  await expect.poll(revision).toBe(before + 2);
  watched.clean();
});

test('a GitHub permission is switched off and on, and the application remembers it', async ({ page }) => {
  const watched = watch(page);
  await page.goto('/tools');
  await connected(page);
  const row = page
    .getByRole('listitem')
    .filter({ has: page.getByRole('heading', { name: 'GitHub · create repositories' }) });
  await expect(row.getByText('Enabled', { exact: true })).toBeVisible();
  await row.getByRole('button', { name: 'Disable' }).click();
  await expect(row.getByText('Disabled', { exact: true })).toBeVisible();
  await page.reload();
  await connected(page);
  await expect(row.getByText('Disabled', { exact: true })).toBeVisible();
  await row.getByRole('button', { name: 'Enable' }).click();
  await expect(row.getByText('Enabled', { exact: true })).toBeVisible();
  watched.clean();
});

test('Tools lists every tool the application gives a specialist, and what one is for QA', async ({
  page,
}) => {
  const watched = watch(page);
  await page.goto('/tools?tab=builtin');
  await connected(page);
  for (const name of [
    'read_files',
    'search_source',
    'edit_source',
    'execute',
    'read_context',
    'read_memory',
    'record_note',
    'propose_memory',
    'browser_verify',
  ])
    await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
  // QA is given fewer tools, and its `execute` runs only an approved check.
  await page.getByRole('combobox', { name: 'Specialist' }).selectOption('qa');
  await expect(page.getByRole('heading', { name: 'edit_source', exact: true })).toHaveCount(0);
  await expect(page.getByText(/^Run an approved check in a disposable copy/)).toBeVisible();
  watched.clean();
});

test('Memory opens on a project the factory has not read yet', async ({ page }) => {
  const watched = watch(page);
  const name = unique('Memory');
  await addProject(page, name);
  await page.goto('/memory');
  await connected(page);
  await page.getByRole('combobox', { name: 'Project', exact: true }).selectOption({ label: name });
  for (const tab of ['Knowledge map', 'Records', 'Review queue', 'Recall log']) {
    await page.getByRole('tab', { name: tab, exact: true }).click();
    await expect(page.getByRole('tabpanel')).toBeVisible();
  }
  // Without an indexed commit there is nothing to anchor a record to, and the dialog says so.
  await page.getByRole('button', { name: 'Propose memory' }).click();
  const dialog = page.getByRole('dialog', { name: 'Propose project memory' });
  await expect(dialog.getByText('Read the repository first.', { exact: false })).toBeVisible();
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await archiveProject(page, name);
  watched.clean();
});

test('the Supervisor of an instance without a model provider says so and leads to the provider form', async ({
  page,
}) => {
  const watched = watch(page);
  await page.goto('/runs');
  await connected(page);
  await page.getByRole('button', { name: 'Supervisor', exact: true }).click();
  const conversation = page.getByRole('region', { name: 'Supervisor conversation' });
  // The fixture has no provider key: the application reports the Supervisor's role as not callable.
  await expect(conversation.getByRole('heading', { name: 'The Supervisor has no model yet' })).toBeVisible();
  await conversation.getByRole('link', { name: 'Connect model provider' }).click();
  await expect(page).toHaveURL(/\/config\?section=provider$/);
  await expect(page.getByRole('heading', { name: 'Connect a model provider' })).toBeVisible();
  watched.clean();
});

test('Agents shows the production line of every flow the application defines', async ({ page }) => {
  const watched = watch(page);
  await page.goto('/agents');
  await connected(page);
  for (const flow of ['Patch', 'Maintain', 'Create', 'Audit']) {
    await page.getByRole('button', { name: flow, exact: true }).click();
    await expect(page.getByRole('button', { name: flow, exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(page.getByText('Intake', { exact: true }).first()).toBeVisible();
  }
  watched.clean();
});
