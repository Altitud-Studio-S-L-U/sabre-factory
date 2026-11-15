import { test as setup, expect } from '@playwright/test';
import { connected, session } from './fixture';

setup('pair this browser with the fixture', async ({ page }) => {
  const link = process.env.SABRE_REAL_PAIRING;
  // The link carries a one-use ticket. The launcher hands it over; it is in no file and no argument.
  expect(link, 'Start the journeys with node infra/qa.mjs check').toBeTruthy();
  await page.goto(link!);
  await connected(page);
  // The console removes the ticket from the address before it exchanges it.
  expect(page.url()).not.toContain('ticket');
  await page.context().storageState({ path: session });
});
