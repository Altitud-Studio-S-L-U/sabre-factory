import { defineConfig, devices } from '@playwright/test';

// SABRE_BROWSER_PORT and SABRE_BROWSER_RESULTS let two suites run side by side
// without sharing a server port or a results folder.
const port = Number(process.env.SABRE_BROWSER_PORT ?? 4173);
const outputDir = process.env.SABRE_BROWSER_RESULTS ?? '../work/browser-results';

export default defineConfig({
  testDir: './e2e',
  outputDir,
  retries: 0,
  workers: 1,
  use: { baseURL: `http://127.0.0.1:${port}`, trace: 'retain-on-failure' },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 1000 } } },
    { name: 'mobile', use: { ...devices['Pixel 7'], viewport: { width: 390, height: 844 } } },
  ],
  webServer: {
    command: `node node_modules/vite/bin/vite.js --host 127.0.0.1 --port ${port} --strictPort`,
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: false,
    env: { SABRE_E2E: '1' },
  },
});
