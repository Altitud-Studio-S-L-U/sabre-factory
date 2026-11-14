import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const launcher = resolve(root, 'bin', 'sabre.mjs');

test('the launcher help names every command it routes', () => {
  const source = readFileSync(launcher, 'utf8');
  const routed = [...source.matchAll(/new Set\(\[([^\]]+)\]\)/g)].flatMap((match) => [...match[1].matchAll(/'([a-z-]+)'/g)].map((name) => name[1]));
  // Two sets are declared: the operator commands and the factory operations.
  assert.ok(routed.includes('runs') && routed.includes('migrate-credentials') && routed.includes('stop'));
  const help = execFileSync(process.execPath, [launcher, 'help'], { encoding: 'utf8' });
  const named = new Set(help.match(/[a-z][a-z-]+/g));
  assert.deepEqual(routed.filter((command) => !named.has(command)), []);
  for (const command of ['doctor', 'backup', 'verify', 'restore', 'bench', 'mcp', 'mcp-stdio']) assert.ok(named.has(command), command);
  // The bearer token stays a terminal-only action of the operations script, never a sabre command.
  assert.ok(!named.has('access-token') && !routed.includes('access-token'));
});

test('every launcher script parses', () => {
  // A script that acts on Docker when it loads is imported by no test, so nothing else reads it:
  // the isolated QA launcher carried a syntax error for a week without a failing check.
  const scripts = ['bin', 'infra', join('web', 'scripts')].flatMap((folder) =>
    readdirSync(resolve(root, folder), { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.mjs') && !entry.parentPath.includes('node_modules'))
      .map((entry) => resolve(entry.parentPath, entry.name)));
  assert.ok(scripts.some((path) => path.endsWith('qa.mjs')) && scripts.length > 30, `${scripts.length} scripts found`);
  const broken = scripts.filter((path) => spawnSync(process.execPath, ['--check', path], { stdio: 'ignore' }).status !== 0);
  assert.deepEqual(broken.map((path) => relative(root, path).replaceAll('\\', '/')), []);
});
