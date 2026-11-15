import { defineConfig, devices } from '@playwright/test';
import { results, session } from './e2e-real/fixture';

// Journeys against the console as the application serves it: the real API and a real PostgreSQL of
// the isolated QA fixture, with no model provider. Start them with `node infra/qa.mjs check`, which
// hands this process a one-use pairing link; the other suite (playwright.config.ts) mocks the API.
export default defineConfig({
  testDir: './e2e-real',
  outputDir: results,
  retries: 0,
  workers: 1,
  use: { baseURL: process.env.SABRE_REAL_URL ?? 'http://127.0.0.1:8001', trace: 'retain-on-failure' },
  projects: [
    // A trace of the pairing would keep the one-use ticket on disk.
    {
      name: 'pair',
      testMatch: /pair\.setup\.ts/,
      teardown: 'sign out',
      use: { ...devices['Desktop Chrome'], trace: 'off' },
    },
    { name: 'sign out', testMatch: /signout\.teardown\.ts/, use: { ...devices['Desktop Chrome'] } },
    {
      name: 'desktop',
      dependencies: ['pair'],
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 1000 }, storageState: session },
    },
    {
      name: 'mobile',
      dependencies: ['pair'],
      use: { ...devices['Pixel 7'], viewport: { width: 390, height: 844 }, storageState: session },
    },
  ],
});
