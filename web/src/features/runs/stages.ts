import type { WorkOrder } from '../../api';

/**
 * The seven stages of the sabre-v1 production line, as the runs table shows them. Each workflow
 * phase belongs to exactly one stage; clarification phases stay in the stage that asked.
 */
export const STAGES = [
  { id: 'understand', label: 'Understand' },
  { id: 'plan', label: 'Plan' },
  { id: 'build', label: 'Build' },
  { id: 'verify', label: 'Verify' },
  { id: 'review', label: 'Review' },
  { id: 'security', label: 'Security' },
  { id: 'deliver', label: 'Deliver' },
] as const;

export type StageId = (typeof STAGES)[number]['id'];
export type StageState = 'done' | 'current' | 'pending' | 'skipped';
export type StageTone = 'active' | 'attention' | 'danger' | 'idle' | 'success';

const phaseStage: Record<string, StageId> = {
  intake: 'understand',
  reproduction: 'understand',
  analysis: 'understand',
  analyze: 'understand',
  clarification: 'understand',
  design: 'plan',
  design_clarification: 'plan',
  architecture: 'plan',
  architecture_approval: 'plan',
  planning: 'plan',
  plan: 'plan',
  plan_clarification: 'plan',
  implementation: 'build',
  implement: 'build',
  task_clarification: 'build',
  repair: 'build',
  verification: 'verify',
  verify: 'verify',
  qa_clarification: 'verify',
  scope_check: 'verify',
  scope_approval: 'verify',
  review: 'review',
  review_clarification: 'review',
  security: 'security',
  security_watch: 'security',
  decision: 'deliver',
  prepare_delivery: 'deliver',
  ready: 'deliver',
  delivery: 'deliver',
  deliver: 'deliver',
  audit_report: 'deliver',
  remember: 'deliver',
  complete: 'deliver',
  completed: 'deliver',
};

/** Stages a mode never runs: an audit reports without planning or changing code. */
const skippedByMode: Partial<Record<WorkOrder['mode'], StageId[]>> = {
  audit: ['plan', 'build'],
};

export function stageOf(phase: string): StageId | null {
  return phaseStage[phase] ?? null;
}

export function stageTone(status: WorkOrder['status']): StageTone {
  if (status === 'running' || status === 'queued') return 'active';
  if (status === 'waiting_input' || status === 'blocked' || status === 'paused') return 'attention';
  if (status === 'failed') return 'danger';
  if (status === 'completed') return 'success';
  return 'idle';
}

export interface StageProgress {
  id: StageId;
  label: string;
  state: StageState;
}

/** Where a run stands on the line. Unknown phases leave every applicable stage pending. */
export function stageProgress(order: Pick<WorkOrder, 'mode' | 'phase' | 'status'>): StageProgress[] {
  const skipped = new Set(skippedByMode[order.mode] ?? []);
  const current = stageOf(order.phase);
  const currentIndex = current ? STAGES.findIndex((stage) => stage.id === current) : -1;
  return STAGES.map((stage, index) => {
    let state: StageState;
    if (skipped.has(stage.id)) state = 'skipped';
    else if (order.status === 'completed') state = 'done';
    else if (currentIndex < 0) state = 'pending';
    else if (index < currentIndex) state = 'done';
    else if (index === currentIndex) state = 'current';
    else state = 'pending';
    return { id: stage.id, label: stage.label, state };
  });
}

export function currentStageLabel(order: Pick<WorkOrder, 'mode' | 'phase' | 'status'>): string | null {
  if (order.status === 'completed') return null;
  return stageProgress(order).find((stage) => stage.state === 'current')?.label ?? null;
}
