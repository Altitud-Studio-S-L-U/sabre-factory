import { useEffect, useRef, useState } from 'react';

/**
 * What the Supervisor is observably doing. Each state comes from recorded facts (connection,
 * message states, pending questions, the owner's draft); none suggests hidden reasoning.
 */
export type Presence =
  | 'offline'
  | 'idle'
  | 'listening'
  | 'queued'
  | 'working'
  | 'needs-you'
  | 'done'
  | 'blocked';

export interface PresenceFacts {
  disconnected: boolean;
  /** States of the visible conversation, oldest first. */
  messages: { state: 'queued' | 'running' | 'completed' | 'blocked'; created_at: string }[];
  /** Runs with pending owner questions or blocked/failed status. */
  attention: number;
  /** The owner is typing a message. */
  drafting: boolean;
  /** Milliseconds since the latest message settled, when it did. */
  settledAgoMs?: number | null;
}

export const presenceLabels: Record<Presence, string> = {
  offline: 'Offline',
  idle: 'Ready',
  listening: 'Listening',
  queued: 'Message queued',
  working: 'Working',
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
  if (facts.messages.some((message) => message.state === 'running')) return 'working';
  if (facts.messages.some((message) => message.state === 'queued')) return 'queued';
  if (latest?.state === 'blocked') return 'blocked';
  if (facts.attention > 0) return 'needs-you';
  if (latest?.state === 'completed' && facts.settledAgoMs != null && facts.settledAgoMs < DONE_WINDOW_MS)
    return 'done';
  if (facts.drafting) return 'listening';
  return 'idle';
}

/** Minimum time a state stays visible, so 2.5 s polling does not make the avatar flicker. */
export const MIN_DWELL_MS = 1200;

/**
 * Holds each state for at least MIN_DWELL_MS. Offline and blocked show immediately: they
 * report a fault the owner should not miss.
 */
export function useStablePresence(next: Presence, now: () => number = Date.now): Presence {
  const [shown, setShown] = useState(next);
  const since = useRef(now());
  useEffect(() => {
    if (next === shown) return;
    const elapsed = now() - since.current;
    const wait = next === 'offline' || next === 'blocked' ? 0 : Math.max(0, MIN_DWELL_MS - elapsed);
    const timer = setTimeout(() => {
      since.current = now();
      setShown(next);
    }, wait);
    return () => clearTimeout(timer);
  }, [next, shown, now]);
  return shown;
}
