import assert from 'node:assert/strict';
import { test } from 'node:test';
import { filterRuns, formatEvent, formatRun, formatRuns, main, option, pendingQuestions, resolveId, usage } from './cli.mjs';

const run = (changes = {}) => ({
  id: 'a1b2c3d4-0000-4000-8000-00000000abcd', mode: 'patch', status: 'waiting_input', phase: 'review', plan_revision: 2,
  objective: 'Round totals half up to cents', calls_used: 7, tokens_used: 18420, active_seconds_used: 252.4,
  summary: 'Waiting for the owner', error_code: null, updated_at: '2026-11-12T10:00:00Z', tasks: [{ status: 'completed', title: 'Fix rounding' }],
  questions: [
    { id: 'q-old-0001', kind: 'clarification', prompt: 'Old?', answer: null, plan_revision: 1, options: [] },
    { id: 'q-new-0002', kind: 'permission', prompt: 'Approve the dependency change?', answer: null, plan_revision: 2, options: ['Approve', 'Review scope'] },
  ],
  evidence: null, ...changes,
});

test('runs are filtered by state family and listed newest first', () => {
  const runs = [run(), run({ id: 'x-done', status: 'completed', updated_at: '2026-11-12T11:00:00Z' }), run({ id: 'x-live', status: 'running' })];
  assert.deepEqual(filterRuns(runs, 'active').map((item) => item.id), ['x-live']);
  assert.deepEqual(filterRuns(runs, 'attention').map((item) => item.status), ['waiting_input']);
  assert.deepEqual(filterRuns(runs, 'closed').map((item) => item.id), ['x-done']);
  assert.throws(() => filterRuns(runs, 'weird'), /--state/);
  const table = formatRuns(runs).split('\n');
  assert.match(table[0], /^RUN\s+STATUS/);
  assert.match(table[1], /x-done/);
  assert.equal(formatRuns([]), 'No runs.');
});

test('run details show only questions of the current revision with their options', () => {
  assert.deepEqual(pendingQuestions(run()).map((question) => question.id), ['q-new-0002']);
  const text = formatRun(run());
  assert.match(text, /0002 \[permission\] Approve the dependency change\? \(Approve \/ Review scope\)/);
  assert.doesNotMatch(text, /Old\?/);
  assert.match(text, /18,420 tokens/);
});

test('identifiers resolve by unique prefix or suffix and refuse ambiguity', () => {
  const ids = ['run-alpha-1111', 'run-beta-2222'];
  assert.equal(resolveId(ids, '2222'), 'run-beta-2222');
  assert.equal(resolveId(ids, 'run-alpha'), 'run-alpha-1111');
  assert.throws(() => resolveId(ids, 'run-'), /several runs/);
  assert.throws(() => resolveId(ids, 'zzz'), /No run matches/);
});

test('options are taken out of the arguments and events read as one line', () => {
  const args = ['--state', 'active', 'extra'];
  assert.equal(option(args, '--state'), 'active');
  assert.deepEqual(args, ['extra']);
  assert.throws(() => option(['--run'], '--run'), /needs a value/);
  const line = formatEvent({ sequence: 4, event: { timestamp: '2026-11-12T10:00:01Z', kind: 'tool', name: 'read_file', state: 'completed', duration_ms: 1400, error_code: null } });
  assert.match(line, /#4\s+tool\s+read_file\s+completed 1\.4 s/);
});

test('destructive and empty commands stop before contacting the factory', async () => {
  const lines = [];
  await assert.rejects(main(['cancel', 'run-1'], { write: (text) => lines.push(text) }), /--yes/);
  await assert.rejects(main(['ask'], { write: (text) => lines.push(text) }), /Write the message/);
  assert.equal(await main(['runs', 'help'], { write: (text) => lines.push(text) }), 0);
  assert.equal(await main(['bogus'], { write: (text) => lines.push(text) }), 2);
  assert.equal(lines.at(-1), usage);
});

test('an owner decision is filed for the console and a clarification is answered directly', async () => {
  const calls = [];
  const pending = run();
  pending.questions[0].plan_revision = 2;
  const call = async (tool, args = {}) => {
    calls.push([tool, args]);
    if (tool === 'sabre_list_work') return { result: [pending] };
    if (tool === 'sabre_get_work') return pending;
    if (tool === 'sabre_propose_answer') return { id: 'c0ffee00-0000-4000-8000-000000000001', state: 'pending' };
    return { ...pending, status: 'queued' };
  };
  const lines = [];
  const io = { write: (text) => lines.push(text), call };
  assert.equal(await main(['answer', 'a1b2', 'q-new', 'Approve'], io), 0);
  assert.match(lines.at(-1), /owner decision\. Nothing changed: confirm it in the console \(request 00000001\)/);
  assert.deepEqual(calls.at(-1), ['sabre_propose_answer', {
    work_id: pending.id, answer: { question_id: 'q-new-0002', plan_revision: 2, answer: 'Approve' },
  }]);
  assert.equal(calls.some(([tool]) => tool === 'sabre_answer_question'), false);
  assert.equal(await main(['answer', 'a1b2', 'q-old', 'It', 'returns', 'zero'], io), 0);
  assert.match(lines.at(-1), /^Answer recorded\. Run 0000abcd is queued\.$/);
  assert.deepEqual(calls.at(-1), ['sabre_answer_question', {
    work_id: pending.id, answer: { question_id: 'q-old-0001', plan_revision: 2, answer: 'It returns zero' },
  }]);
});
