import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extractReport, summarize } from './bench.mjs';

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
