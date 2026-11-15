import type { OwnerConfirmation, WorkOrder } from '../../api';

/**
 * What the owner should look at, and what this browser has already shown or acknowledged.
 * The server keeps every request and decision; this only remembers which ones were announced
 * here and which failures the owner dismissed, so a reload does not repeat them.
 */
const STORE = 'sabre.attention.v1';
const REMEMBERED = 200;

type Memory = { dismissed: string[]; announced: string[] };
export type MemoryList = keyof Memory;

function load(): Memory {
  try {
    const value = JSON.parse(localStorage.getItem(STORE) ?? '{}') as Partial<Memory>;
    const list = (entry: unknown) =>
      Array.isArray(entry) ? entry.filter((item): item is string => typeof item === 'string') : [];
    return { dismissed: list(value.dismissed), announced: list(value.announced) };
  } catch {
    return { dismissed: [], announced: [] };
  }
}

export function remembered(list: MemoryList): Set<string> {
  return new Set(load()[list]);
}

/** Adds ids to a list. Storage may be unavailable; the console then simply repeats itself after a reload. */
export function remember(list: MemoryList, ids: string[]) {
  if (!ids.length) return;
  const memory = load();
  memory[list] = [...new Set([...memory[list], ...ids])].slice(-REMEMBERED);
  try {
    localStorage.setItem(STORE, JSON.stringify(memory));
  } catch {
    // Private windows and blocked storage: nothing to keep.
  }
}

/** How long a decision that did not take effect stays in the inbox. */
export const PROBLEM_WINDOW_MS = 24 * 60 * 60 * 1000;
/** A request is "applying" for a moment while the server works; only a lasting one is an unknown outcome. */
const SETTLING_MS = 60 * 1000;

/** Decisions that were refused, or whose outcome is unknown, and that the owner has not dismissed. */
export function unresolved(
  items: OwnerConfirmation[],
  dismissed: ReadonlySet<string>,
  now: number = Date.now(),
): OwnerConfirmation[] {
  return items.filter((item) => {
    if (dismissed.has(item.id) || (item.state !== 'failed' && item.state !== 'applying')) return false;
    const decided = item.decided_at ? Date.parse(item.decided_at) : NaN;
    if (Number.isNaN(decided)) return item.state === 'failed';
    const age = now - decided;
    return age < PROBLEM_WINDOW_MS && (item.state === 'failed' || age > SETTLING_MS);
  });
}

export type AttentionTone = 'danger' | 'warning' | null;

/** Red for something that went wrong, amber for something that waits for the owner. */
export function attentionTone(facts: {
  problems: number;
  failedRuns: number;
  waiting: number;
}): AttentionTone {
  if (facts.problems > 0 || facts.failedRuns > 0) return 'danger';
  return facts.waiting > 0 ? 'warning' : null;
}

export interface AttentionToast {
  id: string;
  tone: 'success' | 'warning' | 'danger';
  title: string;
  text: string;
  /** A run to open, or the Supervisor inbox to review. */
  run?: string;
  review?: boolean;
}

type RunFacts = Pick<WorkOrder, 'id' | 'objective' | 'status' | 'error_code'> &
  Partial<Pick<WorkOrder, 'phase'>>;

/** What a run that changed state while the owner watched is worth saying. Most transitions say nothing. */
export function runTransition(order: RunFacts, before: string | undefined): AttentionToast | null {
  if (before === undefined || before === order.status) return null;
  const base = { id: `run:${order.id}:${order.status}`, text: order.objective, run: order.id };
  // The daily security review is not a run of the owner's: one that finished says nothing, and one
  // that could not finish says what it is.
  if (order.phase === 'security_watch')
    return order.status === 'blocked' || order.status === 'failed'
      ? {
          ...base,
          tone: order.status === 'failed' ? 'danger' : 'warning',
          title: `Security monitoring could not finish${order.error_code ? ` · ${order.error_code}` : ''}`,
        }
      : null;
  if (order.status === 'completed') return { ...base, tone: 'success', title: 'Run completed' };
  if (order.status === 'failed')
    return {
      ...base,
      tone: 'danger',
      title: `Run failed${order.error_code ? ` · ${order.error_code}` : ''}`,
    };
  if (order.status === 'blocked')
    return {
      ...base,
      tone: 'warning',
      title: `Run blocked${order.error_code ? ` · ${order.error_code}` : ''}`,
    };
  if (order.status === 'waiting_input')
    return { ...base, tone: 'warning', title: 'A run is waiting for your answer' };
  return null;
}
