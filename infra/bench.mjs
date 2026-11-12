// SABRE Bench launcher: runs the reference-policy bench in the development image
// (no network, no model provider) and saves the JSON report under work/bench/.
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

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
  const rows = report.tasks.map((task) => {
    const failedProbes = Object.entries(task.probes).filter(([, value]) => value === false).map(([name]) => name);
    return `${task.grade.verdict.padEnd(4)}  ${task.task.padEnd(18)} calls ${String(task.calls.total).padStart(3)}  `
      + `est. tokens ${String(task.tokens.estimated_total).padStart(6)}  reserved ${String(task.tokens.reserved_total).padStart(7)}  `
      + `max sent ${String(task.context.sent_bytes_max).padStart(6)} B${failedProbes.length ? `  probes off: ${failedProbes.join(', ')}` : ''}`;
  });
  const { summary } = report;
  return [...rows, `${summary.passed}/${summary.tasks} tasks passed (${report.driver}; tokens ${report.token_basis}).`].join('\n');
}

async function main(args) {
  const child = spawn(process.execPath, [resolve(root, 'infra', 'dev.mjs'), 'run', 'uv', 'run', '--no-sync', 'python', '-m', 'sabre.bench', ...args],
    { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'inherit'] });
  let stdout = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  const code = await new Promise((ok, fail) => { child.once('error', fail); child.once('close', (value) => ok(value ?? 1)); });
  const report = extractReport(stdout);
  if (!report) {
    console.error('SABRE Bench did not produce a report.');
    return code || 2;
  }
  await mkdir(resolve(root, 'work', 'bench'), { recursive: true });
  const target = resolve(root, 'work', 'bench', `bench-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  await writeFile(target, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(summarize(report));
  console.log(`Report: ${target}`);
  return report.summary.failed === 0 ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
