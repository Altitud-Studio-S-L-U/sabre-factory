import type { WorkOrder } from './api';

/**
 * Run-state semantics shared by every console surface.
 *
 * The run status decides what is current. A retained `error_code` is a current stop reason only while the
 * run can still be resumed; once the run is closed the same code is history. Pure predicates over the
 * persisted projection: this module never derives execution state of its own.
 */
type RunState = Pick<WorkOrder, 'status' | 'error_code'>;

export const CLOSED_STATUSES: readonly WorkOrder['status'][] = ['completed', 'cancelled'];
export const STOPPED_STATUSES: readonly WorkOrder['status'][] = ['paused', 'blocked', 'failed'];
export const ACTIVE_STATUSES: readonly WorkOrder['status'][] = ['queued', 'running'];
export const ATTENTION_STATUSES: readonly WorkOrder['status'][] = [
  'blocked',
  'failed',
  'waiting_input',
  'paused',
];

/** Owner pause/cancel requests are control outcomes, not errors (older rows stored them as error codes). */
const CONTROL_CODES = new Set(['PAUSE_REQUESTED', 'CANCEL_REQUESTED']);

export function isClosed(order: Pick<WorkOrder, 'status'>): boolean {
  return CLOSED_STATUSES.includes(order.status);
}

export function isStopped(order: Pick<WorkOrder, 'status'>): boolean {
  return STOPPED_STATUSES.includes(order.status);
}

export function isControlCode(code: string | null | undefined): boolean {
  return !!code && CONTROL_CODES.has(code);
}

function recordedCode(order: RunState): string | null {
  return order.error_code && !isControlCode(order.error_code) ? order.error_code : null;
}

/** The code that currently stops a resumable run, or null. */
export function currentBlocker(order: RunState): string | null {
  return isStopped(order) ? recordedCode(order) : null;
}

/** A code retained on a closed run: inspectable evidence, never a pending decision. */
export function historicalError(order: RunState): string | null {
  return isClosed(order) ? recordedCode(order) : null;
}

export function isBudgetCode(code: string | null | undefined): boolean {
  return (
    !!code &&
    code !== 'CONTEXT_BUDGET_EXHAUSTED' &&
    (code.startsWith('BUDGET_') || code.endsWith('_BUDGET_EXHAUSTED') || code === 'TIME_BUDGET')
  );
}

/** Unanswered questions of the current plan revision. A closed run has no pending decisions. */
export function pendingQuestions<T extends Pick<WorkOrder, 'status' | 'plan_revision' | 'questions'>>(
  order: T,
): T['questions'] {
  if (isClosed(order)) return [];
  return order.questions.filter(
    (question) => question.answer === null && question.plan_revision === order.plan_revision,
  );
}
