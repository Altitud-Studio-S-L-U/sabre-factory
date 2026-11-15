import { createRequire } from 'node:module';
import { expect, type Page } from '@playwright/test';

/** Where the journeys keep what they write: results, captures and the session of the paired browser. */
export const results = process.env.SABRE_BROWSER_RESULTS ?? '../work/browser-results-real';
/** The session of the browser paired with the fixture. It dies with the fixture. */
export const session = `${results}/session.json`;

/**
 * A request the application answers with an error on purpose, with the reason it is not a defect.
 * Anything else that fails is one.
 */
export interface Expected {
  method?: string;
  path: RegExp;
  status: number;
  why: string;
}

/**
 * Everything that went wrong while a page was used: a request the application refused or failed,
 * an uncaught exception and an error written to the console. The mocked journeys cannot see any of
 * these, because their API answers whatever the console asks.
 */
export function watch(page: Page, expected: Expected[] = []) {
  const problems: string[] = [];
  page.on('response', (response) => {
    const status = response.status();
    if (status < 400) return;
    const request = response.request();
    const url = new URL(response.url());
    const allowed = expected.some(
      (item) =>
        item.status === status &&
        item.path.test(url.pathname) &&
        (!item.method || item.method === request.method()),
    );
    if (!allowed) problems.push(`${request.method()} ${url.pathname}${url.search} answered ${status}`);
  });
  page.on('requestfailed', (request) => {
    // A navigation aborts the requests of the page it leaves.
    if (request.failure()?.errorText === 'net::ERR_ABORTED') return;
    problems.push(
      `${request.method()} ${new URL(request.url()).pathname} failed: ${request.failure()?.errorText}`,
    );
  });
  page.on('pageerror', (error) => problems.push(`uncaught: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    const text = message.text();
    // The browser repeats every refused request as a console error; the response above already names it.
    if (text.startsWith('Failed to load resource')) return;
    problems.push(`console: ${text}`);
  });
  return {
    problems,
    /** Nothing failed since the page was opened. */
    clean: () => expect(problems, problems.join('\n')).toEqual([]),
  };
}

/**
 * The first load finished and the factory answered it. A refused or failed load leaves a notice; a
 * narrow window shows no "connected" label, so the label cannot be the signal.
 */
export async function connected(page: Page) {
  await expect(page.getByRole('button', { name: 'Refresh data' })).toBeEnabled();
  await expect(page.getByText('Data could not be refreshed.')).toHaveCount(0);
}

/** A name no other journey, viewport or earlier run of the fixture has used. */
export const unique = (label: string) =>
  `${label} ${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;

/** The address a journey registers for a name. Nothing is fetched from it: no run starts here. */
export const repositoryOf = (name: string) =>
  `https://github.com/sabre-journeys/${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;

/** Adds a project by address through the console, the way an owner does. */
export async function addProject(page: Page, name: string) {
  await page.goto('/projects');
  await page.getByRole('button', { name: '+ Add project' }).click();
  const dialog = page.getByRole('dialog', { name: 'Add project' });
  await dialog.getByRole('button', { name: 'By address' }).click();
  await dialog.getByLabel('Project name').fill(name);
  await dialog.getByLabel('Repository', { exact: true }).fill(repositoryOf(name));
  await dialog.getByRole('button', { name: 'Register project' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
}

/** Archives a project so the fixture's lists stay short across journeys and viewports. */
export async function archiveProject(page: Page, name: string) {
  await page.goto('/projects');
  await page.getByRole('button', { name: `Archive ${name}`, exact: true }).click();
  await page
    .getByRole('dialog', { name: `Archive ${name}` })
    .getByRole('button', { name: 'Archive project' })
    .click();
  await expect(page.getByText(`${name} archived. Its runs and memory are kept.`)).toBeVisible();
}

const axe = createRequire(import.meta.url).resolve('axe-core/axe.min.js');

/** Critical and serious WCAG 2.1 A/AA violations automated rules find on the page as it is now. */
export async function violations(page: Page): Promise<string[]> {
  await page.addScriptTag({ path: axe });
  return page.evaluate(async () => {
    type Result = {
      violations: { id: string; impact: string; help: string; nodes: { target: string[] }[] }[];
    };
    const runner = (
      window as unknown as { axe: { run: (context: Document, options: object) => Promise<Result> } }
    ).axe;
    const result = await runner.run(document, {
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] },
    });
    return result.violations
      .filter((violation) => violation.impact === 'critical' || violation.impact === 'serious')
      .map(
        (violation) =>
          `${violation.id} (${violation.impact}): ${violation.help} at ${violation.nodes
            .slice(0, 4)
            .map((node) => node.target.join(' '))
            .join(' | ')}`,
      );
  });
}
