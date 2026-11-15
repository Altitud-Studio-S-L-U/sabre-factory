import { test, expect } from '@playwright/test';
import { addProject, archiveProject, connected, repositoryOf, unique, watch } from './fixture';

test('a project is added by address, kept by the database, edited, archived and restored', async ({
  page,
}) => {
  const watched = watch(page);
  const name = unique('Journey');
  await addProject(page, name);
  await expect(page.getByText(repositoryOf(name))).toBeVisible();

  // A reload reads it back from PostgreSQL: nothing here lives in the browser.
  await page.reload();
  await connected(page);
  await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();

  const renamed = `${name} renamed`;
  await page.getByRole('button', { name: `Edit ${name}`, exact: true }).click();
  const edit = page.getByRole('dialog', { name: `Edit ${name}` });
  // The repository a project points at is never edited.
  await expect(edit.getByLabel('Repository', { exact: true })).not.toBeEditable();
  await edit.getByLabel('Project name').fill(renamed);
  await edit.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText(`${name} saved.`)).toBeVisible();
  await expect(page.getByRole('heading', { name: renamed, exact: true })).toBeVisible();

  await archiveProject(page, renamed);
  await expect(page.getByRole('button', { name: `Edit ${renamed}`, exact: true })).toHaveCount(0);
  await page.getByRole('checkbox', { name: /^Show archived/ }).check();
  await page.getByRole('button', { name: `Restore ${renamed}`, exact: true }).click();
  await expect(page.getByText(`${renamed} restored.`)).toBeVisible();
  await expect(page.getByRole('button', { name: `Edit ${renamed}`, exact: true })).toBeVisible();

  await archiveProject(page, renamed);
  watched.clean();
});

test('the application refuses a second project for the same repository and the console says why', async ({
  page,
}) => {
  const watched = watch(page, [
    {
      method: 'POST',
      path: /^\/api\/v1\/projects$/,
      status: 409,
      why: 'one repository is one project: the second registration is refused',
    },
  ]);
  const name = unique('Twice');
  await addProject(page, name);
  await page.getByRole('button', { name: '+ Add project' }).click();
  const dialog = page.getByRole('dialog', { name: 'Add project' });
  await dialog.getByLabel('Project name').fill(`${name} again`);
  await dialog.getByLabel('Repository', { exact: true }).fill(repositoryOf(name));
  await dialog.getByRole('button', { name: 'Register project' }).click();
  // The refusal stays in the dialog with the draft, in words an owner can act on.
  await expect(dialog.getByRole('alert')).toBeVisible();
  await expect(dialog.getByRole('alert')).not.toHaveText(/Internal|Traceback|undefined|\[object/);
  await expect(dialog.getByLabel('Project name')).toHaveValue(`${name} again`);
  await dialog.getByRole('button', { name: 'Close Add project' }).click();
  await dialog.getByRole('button', { name: 'Discard changes' }).click();
  await expect(dialog).toBeHidden();
  await archiveProject(page, name);
  watched.clean();
});

test('adding a project offers GitHub, an address and a new repository against the real application', async ({
  page,
}) => {
  const watched = watch(page);
  await page.goto('/projects');
  await page.getByRole('button', { name: '+ Add project' }).click();
  const dialog = page.getByRole('dialog', { name: 'Add project' });
  const source = dialog.getByRole('group', { name: 'Where the project comes from' });
  // No GitHub App is installed on the fixture: the address form comes first.
  await expect(source.getByRole('button', { name: 'By address' })).toHaveAttribute('aria-pressed', 'true');
  await source.getByRole('button', { name: 'From GitHub' }).click();
  await expect(dialog.getByRole('button', { name: 'Search repositories' })).toBeVisible();
  await source.getByRole('button', { name: 'New repository' }).click();
  await expect(dialog.getByRole('button', { name: 'Propose repository' })).toBeVisible();
  await expect(dialog.getByText('No proposals yet.', { exact: false })).toBeVisible();
  watched.clean();
});
