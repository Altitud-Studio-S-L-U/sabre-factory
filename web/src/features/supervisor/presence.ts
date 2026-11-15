import { useEffect, useRef, useState } from 'react';

/**
 * What the Supervisor is observably doing. Each state comes from recorded facts (connection,
 * whether its model can be called, message states, pending questions, the owner's draft); none
 * suggests hidden reasoning.
 */
export type Presence =
  | 'offline'
  | 'no-model'
  | 'idle'
  | 'listening'
  | 'queued'
  | 'working'
  | 'using-tool'
  | 'needs-you'
  | 'done'
  | 'blocked';

export interface PresenceFacts {
  disconnected: boolean;
  /**
   * False when the factory reports that the Supervisor's model cannot be called: no provider is
   * connected or no model is chosen. Unknown counts as ready, so a status that has not arrived
   * never shows a fault.
   */
  modelReady?: boolean;
  /** States of the visible conversation, oldest first. */
  messages: { state: 'queued' | 'running' | 'completed' | 'blocked'; created_at: string }[];
  /** Runs with pending owner questions or blocked/failed status. */
  attention: number;
  /** The owner is typing a message. */
  drafting: boolean;
  /** Milliseconds since the latest message settled, when it did. */
  settledAgoMs?: number | null;
  /** Name of a tool call recorded as pending for the running message. */
  activeTool?: string | null;
}

/**
 * Whether the factory says the Supervisor's model can be called, from the status it reports for
 * each role. Undefined while the status has not arrived or does not say.
 */
export function supervisorModelReady(status: Record<string, unknown>): boolean | undefined {
  const role = (status.roles as { supervisor?: { configured?: unknown } } | null | undefined)?.supervisor;
  return typeof role?.configured === 'boolean' ? role.configured : undefined;
}

export const presenceLabels: Record<Presence, string> = {
  offline: 'Offline',
  'no-model': 'No model',
  idle: 'Ready',
  listening: 'Listening',
  queued: 'Message queued',
  working: 'Working',
  'using-tool': 'Using a tool',
  'needs-you': 'Needs you',
  done: 'Replied',
  blocked: 'Blocked',
};

/** How long a just-settled reply shows as "Replied" before returning to rest. */
export const DONE_WINDOW_MS = 8000;

/** Highest-priority observable state. Pure: the same facts always give the same state. */
export function presenceFor(facts: PresenceFacts): Presence {
  if (facts.disconnected) return 'offline';
  const latest = facts.messages.at(-1);
  if (facts.messages.some((message) => message.state === 'running'))
    return facts.activeTool ? 'using-tool' : 'working';
  if (facts.messages.some((message) => message.state === 'queued')) return 'queued';
  if (latest?.state === 'blocked') return 'blocked';
  if (facts.attention > 0) return 'needs-you';
  if (latest?.state === 'completed' && facts.settledAgoMs != null && facts.settledAgoMs < DONE_WINDOW_MS)
    return 'done';
  // Nothing above depends on a model; "listening" and "ready" would promise an answer.
  if (facts.modelReady === false) return 'no-model';
  if (facts.drafting) return 'listening';
  return 'idle';
}

/** Minimum time a state stays visible, so 2.5 s polling does not make the avatar flicker. */
export const MIN_DWELL_MS = 1200;

/**
 * Holds each state for at least MIN_DWELL_MS. Offline, blocked and no model show immediately:
 * they report a fault the owner should not miss.
 */
export function useStablePresence(next: Presence, now: () => number = Date.now): Presence {
  const [shown, setShown] = useState(next);
  const since = useRef(now());
  useEffect(() => {
    if (next === shown) return;
    const elapsed = now() - since.current;
    const fault = next === 'offline' || next === 'blocked' || next === 'no-model';
    const wait = fault ? 0 : Math.max(0, MIN_DWELL_MS - elapsed);
    const timer = setTimeout(() => {
      since.current = now();
      setShown(next);
    }, wait);
    return () => clearTimeout(timer);
  }, [next, shown, now]);
  return shown;
}
