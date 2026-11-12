import { describe, expect, it } from 'vitest';
import { currentBlocker, historicalError, isBudgetCode, isClosed, pendingQuestions } from '../runState';
import type { WorkOrder } from '../api';

type Status = WorkOrder['status'];
const statuses: Status[] = [
  'queued',
  'running',
  'waiting_input',
  'paused',
  'blocked',
  'failed',
  'cancelled',
  'completed',
];

const question = (id: string, plan_revision: number, answer: string | null) =>
  ({ id, plan_revision, answer }) as WorkOrder['questions'][number];

describe('run state semantics', () => {
  it('classifies each status and retained error as current blocker, history or neither', () => {
    const table = Object.fromEntries(
      statuses.map((status) => {
        const order = { status, error_code: 'BUDGET_EXHAUSTED' };
        return [status, { blocker: currentBlocker(order), history: historicalError(order) }];
      }),
    );
    expect(table).toEqual({
      queued: { blocker: null, history: null },
      running: { blocker: null, history: null },
      waiting_input: { blocker: null, history: null },
      paused: { blocker: 'BUDGET_EXHAUSTED', history: null },
      blocked: { blocker: 'BUDGET_EXHAUSTED', history: null },
      failed: { blocker: 'BUDGET_EXHAUSTED', history: null },
      cancelled: { blocker: null, history: 'BUDGET_EXHAUSTED' },
      completed: { blocker: null, history: 'BUDGET_EXHAUSTED' },
    });
  });

  it('treats legacy owner control codes as control outcomes rather than errors', () => {
    expect(currentBlocker({ status: 'paused', error_code: 'PAUSE_REQUESTED' })).toBeNull();
    expect(historicalError({ status: 'cancelled', error_code: 'CANCEL_REQUESTED' })).toBeNull();
    expect(historicalError({ status: 'cancelled', error_code: null })).toBeNull();
  });

  it('offers no pending questions for closed runs and only current unanswered ones otherwise', () => {
    const questions = [question('open', 2, null), question('answered', 2, 'yes'), question('stale', 1, null)];
    expect(
      pendingQuestions({ status: 'waiting_input', plan_revision: 2, questions }).map((q) => q.id),
    ).toEqual(['open']);
    expect(pendingQuestions({ status: 'cancelled', plan_revision: 2, questions })).toEqual([]);
    expect(pendingQuestions({ status: 'completed', plan_revision: 2, questions })).toEqual([]);
  });

  it('treats only completed and cancelled runs as closed', () => {
    expect(statuses.filter((status) => isClosed({ status }))).toEqual(['cancelled', 'completed']);
  });

  it('recognises budget stop codes without confusing a context-size failure', () => {
    expect(isBudgetCode('BUDGET_EXHAUSTED')).toBe(true);
    expect(isBudgetCode('BUDGET_TOKENS')).toBe(true);
    expect(isBudgetCode('TIME_BUDGET')).toBe(true);
    expect(isBudgetCode('CONTEXT_BUDGET_EXHAUSTED')).toBe(false);
    expect(isBudgetCode('TOOL_FAILED')).toBe(false);
    expect(isBudgetCode(null)).toBe(false);
  });
});
