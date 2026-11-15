import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test, expect } from '@playwright/test';
import { connected, results, violations, watch } from './fixture';

// Every address the application serves as the console, opened the way a bookmark or a reload opens
// it: a full load from the server, then whatever the page asks the real API for.
const sections = [
  { path: '/runs', heading: 'Runs' },
  { path: '/agents', heading: 'Agents' },
  { path: '/tools', heading: 'Tools' },
  { path: '/tools?tab=mcp', heading: 'Tools' },
  { path: '/tools?tab=notifications', heading: 'Tools' },
  { path: '/tools?tab=builtin', heading: 'Tools' },
  { path: '/memory', heading: 'Memory' },
  { path: '/config', heading: 'Config' },
  { path: '/config?section=access', heading: 'Config' },
  { path: '/config?section=environment', heading: 'Config' },
  { path: '/config?section=history', heading: 'Config' },
  { path: '/config?section=about', heading: 'Config' },
  { path: '/projects', heading: 'Projects' },
  { path: '/security', heading: 'Security' },
  { path: '/insights', heading: 'Insights' },
];

test('the journeys cover every section the application serves', () => {
  // Playwright runs from web/; the list is the one the application serves the console from.
  const file = resolve(process.cwd(), '../backend/src/sabre/console_routes.json');
  const routes = JSON.parse(readFileSync(file, 'utf8')) as { sections: string[] };
  const covered = new Set(sections.map((section) => section.path.split('?')[0].slice(1)));
  // Earlier addresses redirect to a section that is covered.
  const redirected = new Set(['work', 'integrations', 'about']);
  expect(routes.sections.filter((name) => !covered.has(name) && !redirected.has(name))).toEqual([]);
});

for (const section of sections) {
  test(`${section.path} loads from the application without a failed request`, async ({ page }) => {
    const watched = watch(page);
    await page.goto(section.path);
    await expect(page.getByRole('heading', { level: 1, name: section.heading, exact: true })).toBeVisible();
    await connected(page);
    await page.waitForLoadState('networkidle');
    await expect(page.locator('[data-skeleton]')).toHaveCount(0);
    await page.screenshot({
      path: `${results}/captures/${section.path.replace(/[^a-z]+/g, '-').replace(/^-|-$/g, '')}-${test.info().project.name}.png`,
      fullPage: true,
    });
    watched.clean();
    expect(await violations(page)).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}

test('an earlier address still opens its section', async ({ page }) => {
  const watched = watch(page);
  for (const [from, to] of [
    ['/work', /\/runs$/],
    ['/integrations', /\/tools$/],
    ['/about', /\/config\?section=about$/],
  ] as const) {
    await page.goto(from);
    await expect(page).toHaveURL(to);
  }
  watched.clean();
});

test('the console the browser runs is the build the application reports', async ({ page, request }) => {
  const served = (await (await request.get('/build.json')).json()) as { build: string };
  await page.goto('/config?section=about');
  await expect(page.getByText(served.build, { exact: true })).toBeVisible();
});
