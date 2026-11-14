import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const launcher = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'sabre.mjs');

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
