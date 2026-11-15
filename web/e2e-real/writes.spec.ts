import { test, expect } from '@playwright/test';
import { connected, unique, watch } from './fixture';

// What an owner changes on a new instance, sent to the real application and read back from it.
// Each journey leaves the fixture as it found it; none starts work or reaches another service.

test('the default model is chosen, saved by the application and cleared again', async ({ page }) => {
  const watched = watch(page);
  await page.goto('/config?section=models');
  await connected(page);
  const views = page.getByRole('group', { name: 'Configuration views' });
  const name = page.getByRole('textbox', { name: 'Model identifier' });
  // A run that was interrupted leaves its own name behind: that is not a state to put back.
  const found = await name.inputValue();
  const original = found.startsWith('journey-model-') ? '' : found;
  const chosen = `journey-model-${Date.now().toString(36)}`;
  const save = async (value: string) => {
    await name.fill(value);
    await page.getByRole('button', { name: 'Validate & preview' }).click();
    await expect(page.getByText('Schema validated')).toBeVisible();
    await expect(page.getByRole('cell', { name: 'models.default.name' })).toBeVisible();
    await page.getByLabel('I approve the listed model data destinations for this configuration.').check();
    await page.getByRole('button', { name: 'Save configuration' }).click();
    await expect(
      page.getByRole('status').filter({ hasText: 'Configuration saved for future runs' }),
    ).toBeVisible();
  };

  await save(chosen);
  // The application holds it: a reload shows the name, and the readiness list reads it too.
  await page.reload();
  await connected(page);
  await expect(name).toHaveValue(chosen);
  await views.getByRole('button', { name: 'General' }).click();
  await expect(page.getByRole('region', { name: 'Factory readiness' })).toContainText(chosen);

  await views.getByRole('button', { name: 'Models' }).click();
  await save(original);
  await page.reload();
  await connected(page);
  await expect(name).toHaveValue(original);
  watched.clean();
});

test('a specialist draft is saved, validated and published as a new version, then put back', async ({
  page,
}) => {
  const watched = watch(page);
  await page.goto('/agents');
  await connected(page);
  await page
    .getByRole('complementary', { name: 'Local specialists' })
    .getByRole('button', { name: /^DevOps/ })
    .click();
  await expect(page.getByRole('heading', { level: 2, name: 'DevOps' })).toBeVisible();
  const published = async () =>
    Number(
      (
        await page
          .getByRole('complementary', { name: 'Local specialists' })
          .getByRole('button', { name: /^DevOps/ })
          .textContent()
      )?.match(/published v(\d+)/)?.[1],
    );
  const before = await published();
  const marker = unique('Journey note');

  const publish = async (edit: (text: string) => string) => {
    await page.getByRole('button', { name: 'Edit draft' }).click();
    const dialog = page.getByRole('dialog', { name: 'Edit DevOps draft' });
    const instructions = dialog.getByLabel('Instructions', { exact: true });
    await instructions.fill(edit(await instructions.inputValue()));
    await dialog.getByRole('button', { name: 'Save draft' }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByText('Draft saved. Validate and publish it from Versions.')).toBeVisible();
    await page.getByRole('tab', { name: 'Versions', exact: true }).click();
    await page.getByRole('button', { name: 'Validate draft' }).click();
    await expect(page.getByText('Draft validation passed.')).toBeVisible();
    await page.getByRole('button', { name: 'Publish version' }).click();
    await expect(page.getByText('New immutable version published.', { exact: false })).toBeVisible();
  };

  await publish((text) => `${text}\n${marker}`);
  await expect.poll(published).toBe(before + 1);
  // A reload reads the published version back, and its instructions carry the edit.
  await page.reload();
  await connected(page);
  await page
    .getByRole('complementary', { name: 'Local specialists' })
    .getByRole('button', { name: /^DevOps/ })
    .click();
  expect(await published()).toBe(before + 1);
  await page.getByRole('tab', { name: 'Instructions & skills', exact: true }).click();
  await expect(page.getByText(marker)).toBeVisible();

  await publish((text) => text.replace(`\n${marker}`, ''));
  await expect.poll(published).toBe(before + 2);
  await page.getByRole('tab', { name: 'Instructions & skills', exact: true }).click();
  await expect(page.getByText(marker)).toHaveCount(0);
  watched.clean();
});

test('a new repository is proposed and rejected without anything leaving the factory', async ({ page }) => {
  const watched = watch(page);
  const outside: string[] = [];
  page.on('request', (request) => {
    if (!request.url().startsWith('http://127.0.0.1:8001/')) outside.push(request.url());
  });
  const repository = `journey-${Date.now().toString(36)}-${test.info().project.name}`;
  await page.goto('/projects');
  await connected(page);
  await page.getByRole('button', { name: '+ Add project' }).click();
  const dialog = page.getByRole('dialog', { name: 'Add project' });
  await dialog.getByRole('button', { name: 'New repository' }).click();
  await dialog.getByRole('button', { name: 'Propose repository' }).click();
  const form = dialog.getByRole('form', { name: 'Repository proposal' });
  await form.getByLabel('GitHub owner').fill('sabre-journeys');
  await form.getByLabel('Repository name').fill(repository);
  await form.getByLabel('Description').fill('Proposed by a browser journey and rejected by it.');
  await form.getByRole('button', { name: 'Save proposal for review' }).click();

  const proposal = dialog.getByRole('article', { name: `Proposal sabre-journeys/${repository}` });
  await expect(proposal.getByText('Awaiting your decision')).toBeVisible();
  // Creating needs the owner's review ticked first; the journey declines instead.
  await expect(proposal.getByRole('button', { name: 'Approve and create' })).toBeDisabled();
  await proposal.getByRole('button', { name: 'Reject proposal' }).click();
  await expect(proposal.getByText('Rejected', { exact: true })).toBeVisible();
  await expect(proposal.getByRole('button', { name: 'Approve and create' })).toHaveCount(0);
  expect(outside).toEqual([]);
  watched.clean();
});
