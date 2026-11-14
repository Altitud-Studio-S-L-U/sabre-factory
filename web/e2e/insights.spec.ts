import { test, expect } from '@playwright/test';
import { mockFactoryApi } from './fixtures';
import { unmeasuredRunMetrics } from '../src/test/runMetricsFixture';

test.beforeEach(async ({ page }) => {
  await mockFactoryApi(page);
});

test('insights reads the window by period, with the keyboard and as a table', async ({ page }) => {
  await page.goto('/insights');
  await expect(page.getByRole('heading', { name: 'Insights', level: 1 })).toBeVisible();
  await expect(
    page.getByRole('navigation', { name: 'Runs area' }).getByRole('link', { name: 'Insights' }),
  ).toHaveAttribute('aria-current', 'page');
  const summary = page.getByRole('region', { name: 'Summary' });
  await expect(summary).toContainText('$3.42');
  await expect(summary).toContainText('66.7%');
  await expect(summary.locator('[data-unknown]')).toHaveCount(0);
  // The legend names every series and carries the totals of the window.
  const series = page.getByRole('list', { name: 'Series' });
  await expect(page.getByTestId('outcome-period')).toHaveText('Last 30 days');
  await expect(series.getByRole('listitem')).toHaveText(['4Completed', '1Stopped', '1Open', '1Cancelled']);
  await expect(page.getByTestId('outcome-column')).toHaveCount(30);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

  // One tab stop for the plot; the arrows read each period.
  await page.getByTestId('outcome-plot').focus();
  await expect(page.getByTestId('outcome-period')).toHaveText('Nov 14');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');
  await expect(page.getByTestId('outcome-period')).toHaveText('Nov 12');
  await expect(series.getByRole('listitem')).toHaveText(['2Completed', '1Stopped', '0Open', '0Cancelled']);
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('outcome-period')).toHaveText('Last 30 days');

  // Every value of the chart is also in a table.
  await page.getByText('Show as a table').click();
  const table = page.getByRole('region', { name: 'Runs by outcome, as a table' });
  await expect(table.getByRole('row', { name: /Nov 12/ })).toHaveText(/Nov 12\s*3\s*2\s*1\s*0\s*0/);

  // The filters scope everything below them: the window is asked again and read by week.
  const asked = page.waitForRequest((request) => /\/metrics\/runs\?days=90$/.test(request.url()));
  await page.getByRole('group', { name: 'Window' }).getByRole('button', { name: '90 days' }).click();
  await asked;
  await expect(page.getByTestId('outcome-column')).toHaveCount(13);
  await expect(page.getByTestId('outcome-period')).toHaveText('Last 90 days');
  const filtered = page.waitForRequest((request) => /days=90&mode=audit$/.test(request.url()));
  await page.getByRole('combobox', { name: 'Flow' }).selectOption('audit');
  await filtered;
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('insights prints Unknown apart from a measured zero', async ({ page }) => {
  await page.route('**/api/v1/metrics/runs*', (route) => route.fulfill({ json: unmeasuredRunMetrics() }));
  await page.goto('/insights');
  const summary = page.getByRole('region', { name: 'Summary' });
  // No run completed, no call had a price per token and none reported its split: five figures are unknown.
  await expect(summary.locator('[data-unknown]')).toHaveCount(5);
  await expect(summary.locator('[data-unknown]').first()).toHaveText('Unknown');
  await expect(summary).toContainText('Calls ran through a CLI session, which has no price per token');
  // One run ended and none was delivered: a zero that was measured is printed as a zero.
  const delivered = summary.getByText('Delivered, of runs that ended').locator('..');
  await expect(delivered).toContainText('0%');
  await expect(delivered.locator('[data-unknown]')).toHaveCount(0);
  const flows = page.getByRole('region', { name: 'Figures by flow' });
  await expect(flows.getByRole('row', { name: /Audit/ }).locator('[data-unknown]')).toHaveCount(4);
  await expect(page.getByRole('list', { name: 'Tokens by specialist' })).toContainText('cache Unknown');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('insights says when the window has no runs', async ({ page }) => {
  const empty = unmeasuredRunMetrics();
  await page.route('**/api/v1/metrics/runs*', (route) =>
    route.fulfill({
      json: {
        ...empty,
        totals: {
          ...empty.totals,
          runs: 0,
          stopped: 0,
          active: 0,
          calls: 0,
          settled_calls: 0,
          cli_calls: 0,
          measured_tokens: 0,
        },
        by_mode: [],
        by_specialist: [],
        by_day: [],
      },
    }),
  );
  await page.goto('/insights');
  await expect(page.getByRole('heading', { name: 'No runs in this window' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Summary' })).toHaveCount(0);
});
