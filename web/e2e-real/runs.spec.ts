import { test, expect } from '@playwright/test';
import { addProject, archiveProject, connected, unique, watch } from './fixture';

// No journey here launches a run: the fixture has no model provider and no worker, and a run is
// the owner's decision. The wizard is taken to its last step and closed.
test('a new run is prepared with the real project and defaults, and nothing is sent before Launch', async ({
  page,
}) => {
  const watched = watch(page);
  const name = unique('Wizard');
  await addProject(page, name);
  const sent: string[] = [];
  page.on('request', (request) => {
    if (request.method() !== 'GET' && new URL(request.url()).pathname.startsWith('/api/v1/work'))
      sent.push(`${request.method()} ${new URL(request.url()).pathname}`);
  });

  await page.goto('/runs');
  await connected(page);
  await page.getByRole('button', { name: '+ New run' }).click();
  const dialog = page.getByRole('dialog', { name: 'New run' });
  await dialog.getByRole('combobox', { name: 'Project', exact: true }).selectOption({ label: name });
  await dialog.getByLabel('What do you need?').fill('Describe the public interface of the package.');
  await dialog.getByRole('button', { name: 'Next' }).click();
  await dialog.getByLabel('Acceptance criteria').fill('Every exported function is listed.');
  await dialog.getByRole('button', { name: 'Next' }).click();
  // The limits come from the configuration the application holds, not from the console.
  await expect(dialog.getByLabel('Maximum paid API spend · USD')).toBeVisible();
  await dialog.getByRole('button', { name: 'Next' }).click();
  const review = dialog.getByRole('region', { name: 'Review' });
  await expect(review.getByText(name)).toBeVisible();
  await expect(review.getByText('Describe the public interface of the package.')).toBeVisible();
  await expect(review.getByText('Every exported function is listed.')).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Launch flow' })).toBeVisible();

  await dialog.getByRole('button', { name: 'Close New run' }).click();
  await dialog.getByRole('button', { name: 'Discard changes' }).click();
  await expect(dialog).toBeHidden();
  expect(sent).toEqual([]);
  await archiveProject(page, name);
  watched.clean();
});
