import { act, render, renderHook, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import SupervisorAvatar from '../features/supervisor/SupervisorAvatar';
import {
  DONE_WINDOW_MS,
  MIN_DWELL_MS,
  presenceFor,
  presenceLabels,
  supervisorModelReady,
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
    expect(presenceFor(facts({ messages: [message('completed')], activeTool: 'get_work_budget' }))).toBe(
      'idle',
    );
  });

  it('says it has no model instead of promising an answer, and only when the factory says so', () => {
    // At rest and while the owner types, a Supervisor without a model is neither ready nor listening.
    expect(presenceFor(facts({ modelReady: false }))).toBe('no-model');
    expect(presenceFor(facts({ modelReady: false, drafting: true }))).toBe('no-model');
    // What is recorded still shows first: none of it needs a model to be true.
    expect(presenceFor(facts({ modelReady: false, attention: 1 }))).toBe('needs-you');
    expect(presenceFor(facts({ modelReady: false, messages: [message('blocked')] }))).toBe('blocked');
    expect(presenceFor(facts({ modelReady: false, messages: [message('queued')] }))).toBe('queued');
    expect(presenceFor(facts({ modelReady: false, disconnected: true }))).toBe('offline');
    // A status that has not arrived, or that does not say, is not a fault.
    expect(presenceFor(facts({ modelReady: undefined, drafting: true }))).toBe('listening');
    expect(presenceFor(facts({ modelReady: true }))).toBe('idle');

    expect(supervisorModelReady({})).toBeUndefined();
    expect(supervisorModelReady({ roles: null })).toBeUndefined();
    expect(supervisorModelReady({ roles: { supervisor: { configured: 'yes' } } })).toBeUndefined();
    expect(supervisorModelReady({ roles: { supervisor: { configured: false } } })).toBe(false);
    expect(supervisorModelReady({ roles: { supervisor: { configured: true } } })).toBe(true);
    // The default model is not the Supervisor's: only its own role decides.
    expect(
      supervisorModelReady({ model: { configured: true }, roles: { supervisor: { configured: false } } }),
    ).toBe(false);
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
    rerender({ next: 'no-model' });
    act(() => vi.advanceTimersByTime(0));
    expect(result.current).toBe('no-model');
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
