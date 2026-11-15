import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { sandboxFailures, WORKSPACE_BYTES } from './sandbox-acceptance.mjs';

// What the acceptance script printed on the deployed executor when this check was written.
const passing = {
  red_exit: 1, green_exit: 0, network: 'blocked', orphan_recovered: true, restored_digest: 'a'.repeat(64),
  isolation: { socket: false, broker_state: false, token: false, bootstrap_files: false, bootstrap_env: false, workspace_bytes: WORKSPACE_BYTES },
};

test('an isolated sandbox reports nothing that failed', () => {
  assert.deepEqual(sandboxFailures(passing), []);
});

test('each thing a sandbox must not have is named when it has it', () => {
  assert.deepEqual(sandboxFailures({ ...passing, network: 'unexpected network' }), ['network']);
  for (const fact of ['socket', 'broker_state', 'token', 'bootstrap_files', 'bootstrap_env']) {
    assert.deepEqual(sandboxFailures({ ...passing, isolation: { ...passing.isolation, [fact]: true } }), [fact]);
  }
  assert.deepEqual(sandboxFailures({ ...passing, isolation: { ...passing.isolation, workspace_bytes: 1073741824 } }), ['workspace_bytes']);
  // A gate that passes on the broken source, or fails on the corrected one, did not run against its snapshot.
  assert.deepEqual(sandboxFailures({ ...passing, red_exit: 0 }), ['gate']);
  assert.deepEqual(sandboxFailures({ ...passing, green_exit: 1 }), ['gate']);
  assert.deepEqual(sandboxFailures({ ...passing, orphan_recovered: false }), ['recovery']);
});

test('what the script did not report counts as not held', () => {
  const { token: _token, ...partial } = passing.isolation;
  assert.deepEqual(sandboxFailures({ ...passing, isolation: partial }), ['token']);
  assert.deepEqual(sandboxFailures({ ...passing, isolation: undefined }).includes('unreported'), true);
  assert.ok(sandboxFailures(null).includes('network') && sandboxFailures({}).includes('recovery'));
  // A fact the script starts reporting later is held to the same rule without a change here.
  assert.deepEqual(sandboxFailures({ ...passing, isolation: { ...passing.isolation, host_mount: true } }), ['host_mount']);
});

test('the script still reports the facts this check reads', () => {
  const script = readFileSync(new URL('../backend/tests/runtime_executor_smoke.py', import.meta.url), 'utf8');
  for (const fact of ['socket', 'broker_state', 'token', 'bootstrap_files', 'bootstrap_env', 'workspace_bytes',
    'red_exit', 'green_exit', 'network', 'orphan_recovered']) assert.ok(script.includes(`'${fact}'`) || script.includes(`"${fact}"`), fact);
  assert.ok(script.includes(String(WORKSPACE_BYTES)));
});
