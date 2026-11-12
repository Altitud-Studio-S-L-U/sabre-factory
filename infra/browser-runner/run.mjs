import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { chromium } from 'playwright';

const require = createRequire(import.meta.url);
const input = JSON.parse(await readFile('/tmp/browser-input.json', 'utf8'));
const origin = new URL(input.origin).origin;
if (!/^http:\/\/172\.[0-9.]+:\d+$/.test(origin) && !/^http:\/\/10\.[0-9.]+:\d+$/.test(origin)
    && !/^http:\/\/192\.168\.[0-9.]+:\d+$/.test(origin)) throw new Error('PREVIEW_ORIGIN_INVALID');
const allowedKeys = new Set(['Tab', 'Shift+Tab', 'Enter', 'Escape', 'Space', 'ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight']);
const browser = await chromium.launch({ chromiumSandbox: true, args: ['--disable-dev-shm-usage'] });
const artifacts = [];
const results = [];
try {
  for (const viewportName of input.job.viewports) {
    const viewport = viewportName === 'mobile' ? { width: 390, height: 844 } : { width: 1440, height: 1000 };
    const context = await browser.newContext({ viewport, isMobile: viewportName === 'mobile', hasTouch: viewportName === 'mobile',
      serviceWorkers: 'block', acceptDownloads: false, permissions: [] });
    const report = { viewport: viewportName, size: viewport, operations: [], overflow: false, consoleErrors: [], pageErrors: [], failedRequests: [], deniedRequests: [], accessibility: [] };
    await context.route('**/*', async route => {
      let url;
      try { url = new URL(route.request().url()); } catch { await route.abort(); return; }
      if (!['http:', 'https:'].includes(url.protocol) || url.origin !== origin) {
        if (report.deniedRequests.length < 30) report.deniedRequests.push({ destination: 'outside-approved-preview' });
        await route.abort('blockedbyclient');
        return;
      }
      await route.continue();
    });
    await context.routeWebSocket('**/*', socket => socket.close());
    const page = await context.newPage();
    page.setDefaultTimeout(5000);
    page.setDefaultNavigationTimeout(10000);
    page.on('console', msg => { if (msg.type() === 'error' && report.consoleErrors.length < 30) report.consoleErrors.push('console.error'); });
    page.on('pageerror', () => { if (report.pageErrors.length < 30) report.pageErrors.push('page-error'); });
    page.on('requestfailed', request => { if (report.failedRequests.length < 30) {
      const url = new URL(request.url());
      report.failedRequests.push({ path: url.origin === origin ? url.pathname.slice(0, 300) : 'outside-approved-preview' });
    } });
    page.on('response', response => { if (response.status() >= 400 && report.failedRequests.length < 30) {
      report.failedRequests.push({ path: new URL(response.url()).pathname.slice(0, 300), status: response.status() });
    } });
    if (input.job.trace) await context.tracing.start({ screenshots: true, snapshots: true, sources: false });
    let defectCaptures = 0;
    for (const [index, operation] of input.job.operations.entries()) {
      const item = { index, action: operation.action, passed: false };
      try {
        if (operation.action === 'navigate') {
          const url = new URL(operation.target || '/', origin);
          if (url.origin !== origin || url.username || url.password) throw new Error('NAVIGATION_DENIED');
          const response = await page.goto(url.href, { waitUntil: 'domcontentloaded' });
          if (!response || response.status() >= 400) throw new Error('ROUTE_FAILED');
        } else if (operation.action === 'click') {
          await page.getByRole(operation.role, { name: operation.target, exact: true }).click();
        } else if (operation.action === 'fill') {
          await page.getByLabel(operation.target, { exact: true }).fill(operation.value);
        } else if (operation.action === 'press') {
          if (!allowedKeys.has(operation.value)) throw new Error('KEY_NOT_ALLOWED');
          await page.keyboard.press(operation.value);
        } else if (operation.action === 'expect_text') {
          await page.getByText(operation.target, { exact: true }).waitFor({ state: 'visible' });
        } else if (operation.action === 'expect_visible') {
          await page.getByRole(operation.role, { name: operation.target, exact: true }).waitFor({ state: 'visible' });
        } else if (operation.action === 'expect_focus') {
          const focused = await page.getByRole(operation.role, { name: operation.target, exact: true }).evaluate(element => element === document.activeElement);
          if (!focused) throw new Error('FOCUS_EXPECTATION_FAILED');
        } else throw new Error('OPERATION_UNSUPPORTED');
        item.passed = true;
      } catch (error) {
        const known = new Set(['NAVIGATION_DENIED', 'ROUTE_FAILED', 'KEY_NOT_ALLOWED', 'FOCUS_EXPECTATION_FAILED', 'OPERATION_UNSUPPORTED']);
        item.error = known.has(error.message) ? error.message : 'BROWSER_EXPECTATION_FAILED';
      }
      report.operations.push(item);
      const overflows = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1).catch(() => false);
      report.overflow ||= overflows;
      if ((!item.passed || overflows) && defectCaptures < 2) {
        const capture = await page.screenshot({ fullPage: false, animations: 'disabled', type: 'png', timeout: 5000 });
        if (capture.length > 4000000) throw new Error('BROWSER_ARTIFACT_TOO_LARGE');
        artifacts.push({ kind: 'screenshot', viewport: `${viewportName}-step-${index}`, media_type: 'image/png', content: capture.toString('base64'), review_required: false });
        defectCaptures += 1;
      }
    }
    report.overflow ||= await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
    if (input.job.accessibility) {
      await page.addScriptTag({ content: await readFile(require.resolve('axe-core/axe.min.js'), 'utf8') });
      report.accessibility = await page.evaluate(async () => {
        const result = await window.axe.run(document, { resultTypes: ['violations'] });
        return result.violations.slice(0, 40).map(item => ({ id: item.id, impact: item.impact, nodes: item.nodes.length }));
      });
    }
    const image = await page.screenshot({ fullPage: false, animations: 'disabled', type: 'png', timeout: 5000 });
    if (image.length > 4000000) throw new Error('BROWSER_ARTIFACT_TOO_LARGE');
    artifacts.push({ kind: 'screenshot', viewport: viewportName, media_type: 'image/png', content: image.toString('base64'), review_required: false });
    if (input.job.trace) {
      const path = `/tmp/browser-trace-${viewportName}.zip`;
      await context.tracing.stop({ path });
      const trace = await readFile(path);
      if (trace.length > 16000000) throw new Error('BROWSER_ARTIFACT_TOO_LARGE');
      artifacts.push({ kind: 'trace', viewport: viewportName, media_type: 'application/zip', content: trace.toString('base64'), review_required: true });
    }
    report.passed = report.operations.every(item => item.passed) && !report.overflow && !report.pageErrors.length
      && !report.consoleErrors.length && !report.failedRequests.length && !report.accessibility.length;
    results.push(report);
    await context.close();
  }
} finally {
  await browser.close();
}
await writeFile('/tmp/browser-result.json', JSON.stringify({ version: 1, snapshot_digest: input.job.snapshot_digest,
  evaluator: 'playwright-1.64.0+axe-core-4.11.0', passed: results.every(item => item.passed),
  results, artifacts, visual_review: 'unavailable' }), { mode: 0o600 });
