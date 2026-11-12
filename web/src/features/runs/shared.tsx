import { useState, type ReactNode } from 'react';
import type { WorkOrder } from '../../api';
import Notice from '../../components/Notice';
import StatusBadge from '../../components/StatusBadge';

export const statusLabels: Record<string, string> = {
  queued: 'Queued',
  running: 'Running',
  waiting_input: 'Needs your answer',
  paused: 'Paused',
  blocked: 'Blocked',
  failed: 'Failed',
  cancelled: 'Cancelled',
  completed: 'Completed',
  high: 'High',
  critical: 'Critical',
  medium: 'Medium',
  low: 'Low',
  info: 'Information',
};

export const phaseLabels: Record<string, string> = {
  clarification: 'Clarification',
  task_clarification: 'Task clarification',
  scope_check: 'Scope check',
  scope_approval: 'Scope decision',
  qa_clarification: 'Verification clarification',
  review_clarification: 'Review clarification',
  plan_clarification: 'Plan clarification',
  design_clarification: 'Design clarification',
  architecture_approval: 'Architecture decision',
  decision: 'Evaluation',
  prepare_delivery: 'Delivery preparation',
  ready: 'Ready to deliver',
  repair: 'Repair',
  security_watch: 'Security monitoring',
  intake: 'Input',
  analysis: 'Analysis',
  analyze: 'Analysis',
  planning: 'Planning',
  plan: 'Planning',
  design: 'Design',
  architecture: 'Architecture',
  implement: 'Development',
  implementation: 'Development',
  verify: 'Verification',
  verification: 'Verification',
  review: 'Review',
  security: 'Security',
  delivery: 'Delivery',
  deliver: 'Delivery',
  complete: 'Completed',
  completed: 'Completed',
};

export const modeLabels: Record<string, string> = {
  create: 'Create',
  maintain: 'Maintain',
  patch: 'Patch',
  audit: 'Audit',
};

export const modeDescriptions: Record<WorkOrder['mode'], string> = {
  create: 'Design and build something new',
  maintain: 'Improve an existing project',
  patch: 'Fix a specific defect',
  audit: 'Inspect without modifying project files',
};

export const emptyPlanMessages: Record<WorkOrder['status'], string> = {
  queued: 'The run is waiting for its turn.',
  running: 'The run is in progress. Tasks appear when they are recorded.',
  waiting_input: 'The run needs an answer before continuing.',
  paused: 'The run is paused.',
  blocked: 'The run is blocked. Review the reason before resuming.',
  failed: 'Execution failed. Review the error before resuming.',
  cancelled: 'The run is cancelled.',
  completed: 'The run finished with no recorded tasks.',
};

export const roleLabels: Record<string, string> = {
  analyst: 'Analyst',
  architect: 'Architect',
  developer: 'Developer',
  qa: 'Verification',
  reviewer: 'Reviewer',
};

export function time(value: string) {
  return new Date(value).toLocaleString('en-US', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function lines(value: FormDataEntryValue | null) {
  return String(value || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

export function message(error: unknown) {
  return error instanceof Error ? error.message : 'The operation could not be completed.';
}

export function externalUrl(value: string | null | undefined) {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch {
    return null;
  }
}

export function RunBadge({ value }: { value: string }) {
  return <StatusBadge value={value} label={statusLabels[value] || value} />;
}

export function ErrorNotice({ children }: { children: ReactNode }) {
  return (
    <Notice tone="danger" role="alert">
      {children}
    </Notice>
  );
}

export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError('');
    try {
      await action();
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, run };
}

export function usesOnlyCliModels(status: Record<string, unknown>): boolean {
  const model = status.model as { provider?: unknown } | undefined;
  const roles = status.roles as Record<string, { provider?: unknown }> | undefined;
  const cli = (provider: unknown) => provider === 'codex_cli' || provider === 'claude_cli';
  return (
    cli(model?.provider) &&
    ['supervisor', 'analyst', 'architect', 'developer', 'qa', 'reviewer', 'security'].every((role) =>
      cli(roles?.[role]?.provider),
    )
  );
}

export function CliProgressPolicy() {
  return (
    <div className="grid gap-2 text-sm text-muted-foreground">
      <p>
        Per-agent controls: 50 steps or 10 minutes per agent, 2 repair cycles. No cumulative invocation, token
        or active-time quotas.
      </p>
      <p>
        Authorized API spend: USD 0. Scanners, permission boundaries and the 120-second CLI invocation limit
        remain active. Subscriptions retain their own limits.
      </p>
    </div>
  );
}

/** Ask the surrounding dialog to close through its own guard (busy, unsaved changes). */
export function requestDialogClose(element: HTMLElement, fallback: () => void) {
  const dialog = element.closest('dialog');
  if (dialog) dialog.dispatchEvent(new Event('cancel', { cancelable: true }));
  else fallback();
}
