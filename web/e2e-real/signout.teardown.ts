import { test as teardown, expect } from '@playwright/test';
import { connected, session } from './fixture';

// Runs after the journeys of both viewports. Signing out revokes the session on the application, so
// the file that held it is worthless afterwards.
teardown.use({ storageState: session });

teardown('sign this browser out of the fixture', async ({ page }) => {
  await page.goto('/runs');
  await connected(page);
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('button', { name: 'Sign out' })).toHaveCount(0);
  // The application no longer knows this browser: a reload stays on the access screen.
  await page.reload();
  await expect(page.getByRole('button', { name: 'Sign out' })).toHaveCount(0);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  const refused = await page.request.get('/api/v1/projects');
  expect(refused.status()).toBe(401);
});
