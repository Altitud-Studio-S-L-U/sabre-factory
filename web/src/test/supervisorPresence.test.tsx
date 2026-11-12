import { act, render, renderHook, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import SupervisorAvatar from '../features/supervisor/SupervisorAvatar';
import {
  DONE_WINDOW_MS,
  MIN_DWELL_MS,
  presenceFor,
  presenceLabels,
  useStablePresence,
  type Presence,
  type PresenceFacts,
} from '../features/supervisor/presence';

const facts = (changes: Partial<PresenceFacts> = {}): PresenceFacts => ({
  disconnected: false,
  messages: [],
  attention: 0,
  drafting: false,
  settledAgoMs: null,
  ...changes,
});
const message = (state: PresenceFacts['messages'][number]['state']) => ({
  state,
  created_at: '2026-11-12T10:00:00Z',
});

describe('supervisor presence', () => {
  afterEach(() => vi.useRealTimers());

  it('reflects only observable facts, in priority order', () => {
    expect(presenceFor(facts())).toBe('idle');
    expect(presenceFor(facts({ drafting: true }))).toBe('listening');
    expect(presenceFor(facts({ messages: [message('completed')], settledAgoMs: 0 }))).toBe('done');
    expect(presenceFor(facts({ messages: [message('completed')], settledAgoMs: DONE_WINDOW_MS }))).toBe(
      'idle',
    );
    expect(presenceFor(facts({ attention: 2, drafting: true }))).toBe('needs-you');
    expect(presenceFor(facts({ messages: [message('blocked')], attention: 2 }))).toBe('blocked');
    expect(presenceFor(facts({ messages: [message('blocked'), message('queued')] }))).toBe('queued');
    expect(presenceFor(facts({ messages: [message('queued'), message('running')] }))).toBe('working');
    expect(presenceFor(facts({ disconnected: true, messages: [message('running')] }))).toBe('offline');
    // A pending tool call counts only while a message is running.
    expect(presenceFor(facts({ messages: [message('running')], activeTool: 'get_work_budget' }))).toBe(
      'using-tool',
    );
    expect(presenceFor(facts({ messages: [message('completed')], activeTool: 'get_work_budget' }))).toBe('idle');
  });

  it('holds a state for the minimum dwell time but shows faults immediately', () => {
    vi.useFakeTimers();
    let now = 0;
    const clock = () => now;
    const { result, rerender } = renderHook(
      ({ next }: { next: Presence }) => useStablePresence(next, clock),
      {
        initialProps: { next: 'idle' as Presence },
      },
    );
    rerender({ next: 'working' });
    expect(result.current).toBe('idle');
    now = MIN_DWELL_MS;
    act(() => vi.advanceTimersByTime(MIN_DWELL_MS));
    expect(result.current).toBe('working');
    rerender({ next: 'blocked' });
    act(() => vi.advanceTimersByTime(0));
    expect(result.current).toBe('blocked');
  });

  it('names every state for assistive technology and marks it without relying on colour', () => {
    for (const presence of Object.keys(presenceLabels) as Presence[]) {
      const { unmount, container } = render(<SupervisorAvatar presence={presence} labelled />);
      expect(
        screen.getByRole('img', { name: `Supervisor · ${presenceLabels[presence]}` }),
      ).toBeInTheDocument();
      expect(container.querySelector(`[data-presence="${presence}"]`)).not.toBeNull();
      unmount();
    }
    const { container } = render(<SupervisorAvatar presence="working" />);
    expect(container.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
  });
});
