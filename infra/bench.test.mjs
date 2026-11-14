import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { compare, extractReport, mechanics, suiteDigest, summarize } from './bench.mjs';

const report = {
  version: 1, driver: 'reference_policy', token_basis: 'estimated_utf8_bytes_div_4',
  tasks: [{ task: 'patch-rounding', grade: { verdict: 'pass' }, calls: { total: 11 },
    tokens: { estimated_total: 19817, reserved_total: 250224 }, context: { sent_bytes_max: 22245 },
    probes: { developer_receives_task_acceptance: false, deterministic_gates_before_model_qa: true } }],
  summary: { tasks: 1, passed: 1, failed: 0 },
};

test('the report is recovered from container output with surrounding noise and braces in strings', () => {
  const noisy = `sabre-factory-dev-1\n${JSON.stringify({ ...report, note: 'a } brace' }, null, 2)}\nUntagged: x\n`;
  assert.deepEqual(extractReport(noisy), { ...report, note: 'a } brace' });
  assert.equal(extractReport('no report here'), null);
});

test('the summary names failing probes and the token basis', () => {
  const text = summarize(report);
  assert.match(text, /pass\s+patch-rounding/);
  assert.match(text, /probes off: developer_receives_task_acceptance/);
  assert.doesNotMatch(text, /deterministic_gates_before_model_qa/);
  assert.match(text, /1\/1 tasks passed \(reference_policy; tokens estimated_utf8_bytes_div_4\)/);
});

/** A run as the bench reports it: two tasks, with the timing and trace a comparison must ignore. */
function run(changes = {}) {
  const task = (name, mode, values = {}) => ({
    task: name, mode, status: 'completed', phase: 'done', error_code: null, grade: { verdict: 'pass' }, wall_ms: 1500,
    probes: { deterministic_gates_before_model_qa: true, qa_receives_gate_results: true, repair_receives_work_notes: null },
    calls: { total: 10, by_role: { developer: 4, analyst: 2, qa: 1, reviewer: 2, supervisor: 1 } },
    tokens: { estimated_total: 20000, estimated_input: 18000, estimated_output: 2000, reserved_total: 140000,
      estimated_by_role: { developer: 9000, analyst: 4000, qa: 2000, reviewer: 4000, supervisor: 1000 } },
    context: { sent_bytes_total: 200000, sent_bytes_max: 26000, original_bytes_total: 200000 },
    tools: { calls: { read_file: 3, list_files: 1, write_file: 1, execute: 1 }, failed: 0, output_bytes: 2400, total_ms: 280 },
    work_notes: { scopes: 0, notes: 0 }, stages: ['intake', 'analyze', 'plan', 'implement', 'checks', 'review', 'commit', 'deliver', 'remember'],
    order: ['agent:analyst', 'gate', 'agent:qa'],
    ...values,
  });
  return {
    version: 1, driver: 'reference_policy', token_basis: 'estimated_utf8_bytes_div_4',
    tasks: [task('patch-rounding', 'patch', changes['patch-rounding']), task('audit-pricing', 'audit', changes['audit-pricing'])],
    summary: { tasks: 2, passed: 2, failed: 0 },
  };
}

test('the mechanics of a run leave out timing and do not depend on the order tools finished in', () => {
  const first = mechanics(run());
  const reordered = run({ 'patch-rounding': { wall_ms: 9000,
    tools: { calls: { execute: 1, write_file: 1, list_files: 1, read_file: 3 }, failed: 0, output_bytes: 2400, total_ms: 999 } } });
  assert.equal(JSON.stringify(mechanics(reordered)), JSON.stringify(first));
  assert.deepEqual(Object.keys(first.tasks), ['audit-pricing', 'patch-rounding']);
  const text = JSON.stringify(first);
  for (const absent of ['wall_ms', 'total_ms', 'order']) assert.ok(!text.includes(absent), absent);
  // Harness metrics the evaluation spec asks every driver for.
  assert.equal(first.tasks['patch-rounding'].tokens_per_call, 2000);
  assert.equal(first.tasks['patch-rounding'].recovery_ratio, 0);
  assert.deepEqual(first.summary, { tasks: 2, passed: 2, calls: 20, estimated_tokens: 40000, tokens_per_call: 2000, recovery_ratio: 0,
    token_share_by_role: { analyst: 0.2, developer: 0.45, qa: 0.1, reviewer: 0.2, supervisor: 0.05 } });
});

test('an unchanged run compares clean and each kind of regression is named', () => {
  const baseline = { ...mechanics(run()), suite_digest: 'a'.repeat(64) };
  assert.deepEqual(compare(baseline, { ...mechanics(run()), suite_digest: 'a'.repeat(64) }), { regressions: [], changes: [] });
  const worse = (values) => compare(baseline, { ...mechanics(run({ 'patch-rounding': values })), suite_digest: 'a'.repeat(64) });

  assert.match(worse({ grade: { verdict: 'fail' }, status: 'blocked' }).regressions[0], /patch-rounding: passed in the baseline, now fail \(blocked\)/);
  assert.match(worse({ calls: { total: 11, by_role: { developer: 5, analyst: 2, qa: 1, reviewer: 2, supervisor: 1 } } }).regressions[0], /calls 10 -> 11/);
  assert.match(worse({ tools: { calls: { read_file: 4 }, failed: 2, output_bytes: 2400 } }).regressions[0], /tool failures 0 -> 2/);
  assert.match(worse({ probes: { deterministic_gates_before_model_qa: false, qa_receives_gate_results: true, repair_receives_work_notes: null } })
    .regressions[0], /probe deterministic_gates_before_model_qa was on, now false/);
  const costly = worse({ tokens: { estimated_total: 21000, estimated_input: 18000, reserved_total: 140000,
    estimated_by_role: { developer: 10000, analyst: 4000, qa: 2000, reviewer: 4000, supervisor: 1000 } } });
  assert.deepEqual(costly.regressions, ['patch-rounding: estimated tokens 20000 -> 21000 (+5.0%)']);

  const missing = mechanics(run());
  delete missing.tasks['audit-pricing'];
  assert.deepEqual(compare(baseline, missing).regressions, ['audit-pricing: the task did not run']);
  assert.match(compare(baseline, { ...mechanics(run()), driver: 'provider' }).regressions[0], /not comparable/);
});

test('a difference that is not worse is a change that asks for a new baseline', () => {
  const baseline = { ...mechanics(run()), suite_digest: 'a'.repeat(64) };
  const within = compare(baseline, mechanics(run({ 'patch-rounding': { tokens: { estimated_total: 20200, estimated_input: 18000, reserved_total: 140000,
    estimated_by_role: { developer: 9200, analyst: 4000, qa: 2000, reviewer: 4000, supervisor: 1000 } } } })));
  assert.deepEqual(within, { regressions: [], changes: ['patch-rounding: estimated tokens 20000 -> 20200 (+1.0%)'] });
  const cheaper = compare(baseline, mechanics(run({ 'patch-rounding': { calls: { total: 9, by_role: { developer: 3, analyst: 2, qa: 1, reviewer: 2, supervisor: 1 } },
    context: { sent_bytes_total: 150000, sent_bytes_max: 26000 } } })));
  assert.deepEqual(cheaper.regressions, []);
  assert.deepEqual(cheaper.changes, ['patch-rounding: calls 10 -> 9', 'patch-rounding: sent bytes 200000 -> 150000 (-25.0%)', 'patch-rounding: calls by role changed']);
  const added = mechanics(run());
  added.tasks['maintain-deps'] = added.tasks['patch-rounding'];
  assert.deepEqual(compare(baseline, { ...added, suite_digest: 'b'.repeat(64) }), { regressions: [], changes: [
    'the suite (tasks, fixtures or graders) changed since the baseline was recorded', 'maintain-deps: new task, not in the baseline'] });
});

test('the suite digest follows its files and not the line endings of the checkout', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sabre-bench-suite-'));
  try {
    for (const part of ['tasks', 'repos/pricing', 'graders']) await mkdir(join(directory, part), { recursive: true });
    await writeFile(join(directory, 'tasks', 'one.json'), '{"id": "one"}\n');
    await writeFile(join(directory, 'repos', 'pricing', 'app.py'), 'def total():\n    return 1\n');
    await writeFile(join(directory, 'graders', 'test_one.py'), 'def test_one():\n    assert True\n');
    const digest = await suiteDigest(directory);
    assert.match(digest, /^[a-f0-9]{64}$/);
    await writeFile(join(directory, 'repos', 'pricing', 'app.py'), 'def total():\r\n    return 1\r\n');
    assert.equal(await suiteDigest(directory), digest);
    await writeFile(join(directory, 'repos', 'pricing', 'app.py'), 'def total():\n    return 2\n');
    assert.notEqual(await suiteDigest(directory), digest);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
