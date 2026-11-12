import { describe, expect, it } from 'vitest';
import { currentStageLabel, stageOf, stageProgress, stageTone } from '../features/runs/stages';

const states = (order: Parameters<typeof stageProgress>[0]) =>
  stageProgress(order).map((stage) => stage.state);

describe('production line stages', () => {
  it('places every workflow phase in one stage, clarifications in the stage that asked', () => {
    expect(stageOf('intake')).toBe('understand');
    expect(stageOf('reproduction')).toBe('understand');
    expect(stageOf('plan_clarification')).toBe('plan');
    expect(stageOf('task_clarification')).toBe('build');
    expect(stageOf('scope_approval')).toBe('verify');
    expect(stageOf('review_clarification')).toBe('review');
    expect(stageOf('security')).toBe('security');
    expect(stageOf('decision')).toBe('deliver');
    expect(stageOf('not-a-phase')).toBeNull();
  });

  it('marks earlier stages done, the phase stage current and later stages pending', () => {
    expect(states({ mode: 'patch', phase: 'implementation', status: 'running' })).toEqual([
      'done',
      'done',
      'current',
      'pending',
      'pending',
      'pending',
      'pending',
    ]);
    expect(currentStageLabel({ mode: 'patch', phase: 'implementation', status: 'running' })).toBe('Build');
  });

  it('skips planning and building for an audit and completes every applicable stage', () => {
    expect(states({ mode: 'audit', phase: 'verification', status: 'running' })).toEqual([
      'done',
      'skipped',
      'skipped',
      'current',
      'pending',
      'pending',
      'pending',
    ]);
    expect(states({ mode: 'audit', phase: 'audit_report', status: 'completed' })).toEqual([
      'done',
      'skipped',
      'skipped',
      'done',
      'done',
      'done',
      'done',
    ]);
    expect(currentStageLabel({ mode: 'audit', phase: 'audit_report', status: 'completed' })).toBeNull();
  });

  it('does not invent progress for an unknown phase', () => {
    expect(
      states({ mode: 'patch', phase: 'unrecorded', status: 'queued' }).every((s) => s === 'pending'),
    ).toBe(true);
  });

  it('colours the current stage by run status', () => {
    expect(stageTone('running')).toBe('active');
    expect(stageTone('waiting_input')).toBe('attention');
    expect(stageTone('failed')).toBe('danger');
    expect(stageTone('cancelled')).toBe('idle');
  });
});
