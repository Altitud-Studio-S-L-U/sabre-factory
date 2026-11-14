// SABRE Bench launcher: runs the reference-policy bench in the development image
// (no network, no model provider) and saves the JSON report under work/bench/.
//   sabre bench [--task <id>]   run and save a report
//   sabre bench baseline        run and record backend/bench/reports/baseline.json
//   sabre bench compare [--strict]   run and compare with the recorded baseline
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const suiteRoot = resolve(root, 'backend', 'bench');
const baselinePath = resolve(suiteRoot, 'reports', 'baseline.json');
/** An increase under this share of the baseline is reported as a change, not as a regression. */
export const TOLERANCE = 0.02;

export function extractReport(stdout) {
  const start = stdout.indexOf('{\n  "version"');
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < stdout.length; index += 1) {
    const character = stdout[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
    } else if (character === '"') inString = true;
    else if (character === '{') depth += 1;
    else if (character === '}' && --depth === 0) return JSON.parse(stdout.slice(start, index + 1));
  }
  return null;
}

export function summarize(report) {
  const width = Math.max(18, ...report.tasks.map((task) => task.task.length));
  const rows = report.tasks.map((task) => {
    const failedProbes = Object.entries(task.probes).filter(([, value]) => value === false).map(([name]) => name);
    return `${task.grade.verdict.padEnd(4)}  ${task.task.padEnd(width)} calls ${String(task.calls.total).padStart(3)}  `
      + `est. tokens ${String(task.tokens.estimated_total).padStart(6)}  reserved ${String(task.tokens.reserved_total).padStart(7)}  `
      + `max sent ${String(task.context.sent_bytes_max).padStart(6)} B${failedProbes.length ? `  probes off: ${failedProbes.join(', ')}` : ''}`;
  });
  const { summary } = report;
  return [...rows, `${summary.passed}/${summary.tasks} tasks passed (${report.driver}; tokens ${report.token_basis}).`].join('\n');
}

const byKey = (value) => Object.fromEntries(Object.entries(value ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
const ratio = (part, whole) => (whole ? Math.round((part / whole) * 10000) / 10000 : null);

/**
 * What the harness did, without how long it took: the part of a report that is the same on every
 * run of the same commit. Small, and it holds no prompt, code or path of the host. Maps are sorted
 * by key because the tools of one turn finish in either order.
 */
export function mechanics(report) {
  const tasks = byKey(Object.fromEntries(report.tasks.map((task) => {
    const toolCalls = Object.values(task.tools.calls ?? {}).reduce((sum, count) => sum + count, 0);
    return [task.task, {
      mode: task.mode, verdict: task.grade.verdict, status: task.status,
      calls: task.calls.total, calls_by_role: byKey(task.calls.by_role),
      estimated_tokens: task.tokens.estimated_total, estimated_input_tokens: task.tokens.estimated_input,
      estimated_tokens_by_role: byKey(task.tokens.estimated_by_role), reserved_tokens: task.tokens.reserved_total,
      tokens_per_call: task.calls.total ? Math.round(task.tokens.estimated_total / task.calls.total) : null,
      sent_bytes: task.context.sent_bytes_total, sent_bytes_max: task.context.sent_bytes_max,
      tool_calls: byKey(task.tools.calls), tool_failures: task.tools.failed, tool_output_bytes: task.tools.output_bytes,
      recovery_ratio: ratio(task.tools.failed, toolCalls),
      work_notes: task.work_notes?.notes ?? 0, stages: task.stages, probes: byKey(task.probes),
    }];
  })));
  const all = Object.values(tasks);
  const sum = (key) => all.reduce((total, task) => total + (task[key] ?? 0), 0);
  const roles = {};
  for (const task of all) for (const [role, tokens] of Object.entries(task.estimated_tokens_by_role)) roles[role] = (roles[role] ?? 0) + tokens;
  const toolCalls = all.reduce((total, task) => total + Object.values(task.tool_calls).reduce((count, value) => count + value, 0), 0);
  return {
    version: 1, driver: report.driver, token_basis: report.token_basis, tasks,
    summary: {
      tasks: all.length, passed: all.filter((task) => task.verdict === 'pass').length, calls: sum('calls'),
      estimated_tokens: sum('estimated_tokens'), tokens_per_call: sum('calls') ? Math.round(sum('estimated_tokens') / sum('calls')) : null,
      recovery_ratio: ratio(sum('tool_failures'), toolCalls),
      token_share_by_role: byKey(Object.fromEntries(Object.entries(roles).map(([role, tokens]) => [role, ratio(tokens, sum('estimated_tokens'))]))),
    },
  };
}

// More of these is worse: the same scripted work costing more is a regression of the harness.
const COSTS = ['estimated_tokens', 'estimated_input_tokens', 'reserved_tokens', 'sent_bytes', 'sent_bytes_max', 'tool_output_bytes'];
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Set the mechanics of a run against a recorded baseline. A regression is something that got worse
 * (a task that no longer passes, a probe that turned off, more model calls or tool failures, a cost
 * that grew past the tolerance). A change is any other difference: not worse, but the baseline no
 * longer describes the harness and should be recorded again with the change that caused it.
 */
export function compare(baseline, current, { tolerance = TOLERANCE } = {}) {
  const regressions = [];
  const changes = [];
  if (baseline.driver !== current.driver || baseline.token_basis !== current.token_basis) {
    return { regressions: [`not comparable: the baseline is ${baseline.driver} with ${baseline.token_basis}, this run is ${current.driver} with ${current.token_basis}`], changes };
  }
  if (baseline.suite_digest && current.suite_digest && baseline.suite_digest !== current.suite_digest) {
    changes.push('the suite (tasks, fixtures or graders) changed since the baseline was recorded');
  }
  for (const [name, before] of Object.entries(baseline.tasks)) {
    const after = current.tasks[name];
    if (!after) {
      regressions.push(`${name}: the task did not run`);
      continue;
    }
    if (before.verdict === 'pass' && after.verdict !== 'pass') regressions.push(`${name}: passed in the baseline, now ${after.verdict} (${after.status})`);
    else if (before.verdict !== after.verdict) changes.push(`${name}: verdict ${before.verdict} -> ${after.verdict}`);
    for (const [probe, was] of Object.entries(before.probes)) {
      const now = after.probes[probe];
      if (was === true && now !== true) regressions.push(`${name}: probe ${probe} was on, now ${now}`);
      else if (was !== now) changes.push(`${name}: probe ${probe} ${was} -> ${now}`);
    }
    for (const key of ['calls', 'tool_failures']) {
      if (after[key] > before[key]) regressions.push(`${name}: ${key.replace('_', ' ')} ${before[key]} -> ${after[key]}`);
      else if (after[key] < before[key]) changes.push(`${name}: ${key.replace('_', ' ')} ${before[key]} -> ${after[key]}`);
    }
    for (const key of COSTS) {
      if (after[key] === before[key]) continue;
      const growth = before[key] ? (after[key] - before[key]) / before[key] : Infinity;
      const line = `${name}: ${key.replaceAll('_', ' ')} ${before[key]} -> ${after[key]} (${growth >= 0 ? '+' : ''}${(growth * 100).toFixed(1)}%)`;
      (growth > tolerance ? regressions : changes).push(line);
    }
    for (const key of ['calls_by_role', 'tool_calls', 'stages', 'work_notes']) {
      if (!same(before[key], after[key])) changes.push(`${name}: ${key.replaceAll('_', ' ')} changed`);
    }
  }
  for (const name of Object.keys(current.tasks)) if (!(name in baseline.tasks)) changes.push(`${name}: new task, not in the baseline`);
  return { regressions, changes };
}

/** One digest for everything a task depends on, so a baseline says which suite it measured. */
export async function suiteDigest(directory = suiteRoot) {
  const hash = createHash('sha256');
  async function walk(folder) {
    const entries = (await readdir(folder, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : 1));
    for (const entry of entries) {
      const path = resolve(folder, entry.name);
      if (entry.isDirectory()) {
        if (!['__pycache__', '.pytest_cache'].includes(entry.name)) await walk(path);
      } else {
        hash.update(relative(directory, path).replaceAll('\\', '/'));
        hash.update('\0');
        // Line endings follow the checkout; the digest must not.
        hash.update((await readFile(path, 'utf8')).replaceAll('\r\n', '\n'));
        hash.update('\0');
      }
    }
  }
  for (const part of ['tasks', 'repos', 'graders']) await walk(resolve(directory, part));
  return hash.digest('hex');
}

async function runSuite(args) {
  const child = spawn(process.execPath, [resolve(root, 'infra', 'dev.mjs'), 'run', 'uv', 'run', '--no-sync', 'python', '-m', 'sabre.bench', ...args],
    { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'inherit'] });
  let stdout = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  const code = await new Promise((ok, fail) => { child.once('error', fail); child.once('close', (value) => ok(value ?? 1)); });
  return { report: extractReport(stdout), code };
}

async function main(args) {
  const [action, ...rest] = ['baseline', 'compare'].includes(args[0]) ? args : ['run', ...args];
  const strict = action === 'compare' && rest.includes('--strict');
  const forwarded = rest.filter((value) => value !== '--strict');
  if (action !== 'run' && forwarded.length) {
    console.error(`Use sabre bench ${action}${action === 'compare' ? ' [--strict]' : ''}: it always runs the whole suite.`);
    return 2;
  }
  const { report, code } = await runSuite(forwarded);
  if (!report) {
    console.error('SABRE Bench did not produce a report.');
    return code || 2;
  }
  await mkdir(resolve(root, 'work', 'bench'), { recursive: true });
  const target = resolve(root, 'work', 'bench', `bench-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  await writeFile(target, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(summarize(report));
  console.log(`Report: ${target}`);
  if (action === 'run') return report.summary.failed === 0 ? 0 : 1;
  const current = { ...mechanics(report), suite_digest: await suiteDigest() };
  if (action === 'baseline') {
    if (report.summary.failed !== 0) {
      console.error('Not recorded: a baseline is a run in which every task passes.');
      return 1;
    }
    await mkdir(dirname(baselinePath), { recursive: true });
    await writeFile(baselinePath, `${JSON.stringify(current, null, 2)}\n`, 'utf8');
    console.log(`Baseline recorded: ${relative(root, baselinePath).replaceAll('\\', '/')}`);
    return 0;
  }
  let baseline;
  try { baseline = JSON.parse(await readFile(baselinePath, 'utf8')); }
  catch { console.error('No baseline is recorded. Run sabre bench baseline first.'); return 2; }
  const { regressions, changes } = compare(baseline, current);
  for (const line of regressions) console.log(`regression  ${line}`);
  for (const line of changes) console.log(`change      ${line}`);
  if (regressions.length) {
    console.log(`${regressions.length} regression${regressions.length === 1 ? '' : 's'} against the baseline.`);
    return 1;
  }
  if (changes.length) {
    console.log(`No regression. ${changes.length} change${changes.length === 1 ? '' : 's'}: record the baseline again with the change that caused ${changes.length === 1 ? 'it' : 'them'} (sabre bench baseline).`);
    return strict ? 1 : 0;
  }
  console.log('Same mechanics as the baseline.');
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
