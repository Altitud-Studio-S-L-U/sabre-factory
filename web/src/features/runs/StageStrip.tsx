import type { WorkOrder } from '../../api';
import { cn } from '../../lib/utils';
import { STAGES, stageProgress, stageTone, type StageTone } from './stages';

const currentTones: Record<StageTone, string> = {
  active: 'bg-info motion-safe:animate-pulse',
  attention: 'bg-warning',
  danger: 'bg-danger',
  idle: 'bg-neutral',
  success: 'bg-success',
};

/** Seven-segment position of a run on the production line, with a text equivalent. */
export default function StageStrip({
  order,
  className,
}: {
  order: Pick<WorkOrder, 'mode' | 'phase' | 'status'>;
  className?: string;
}) {
  const stages = stageProgress(order);
  const tone = stageTone(order.status);
  const current = stages.findIndex((stage) => stage.state === 'current');
  const applicable = stages.filter((stage) => stage.state !== 'skipped');
  const label =
    order.status === 'completed'
      ? 'All stages done'
      : current >= 0
        ? `${stages[current].label}, stage ${applicable.indexOf(stages[current]) + 1} of ${applicable.length}`
        : 'Stage not recorded';
  return (
    <div className={cn('grid min-w-0 gap-1.5', className)}>
      <div role="img" aria-label={label} data-testid="stage-strip" className="flex gap-[3px]">
        {stages.map((stage) => (
          <span
            key={stage.id}
            title={stage.label}
            data-state={stage.state}
            className={cn(
              'h-1.5 min-w-2 flex-1 rounded-full',
              stage.state === 'done' && (order.status === 'completed' ? 'bg-success/70' : 'bg-foreground/40'),
              stage.state === 'current' && currentTones[tone],
              stage.state === 'pending' && 'bg-track',
              stage.state === 'skipped' && 'border border-dashed border-border bg-transparent',
            )}
          />
        ))}
      </div>
      <span aria-hidden="true" className="truncate text-xs text-muted-foreground">
        {order.status === 'completed'
          ? order.mode === 'audit'
            ? 'Report ready'
            : 'Delivered'
          : current >= 0
            ? `${stages[current].label} · ${applicable.indexOf(stages[current]) + 1}/${applicable.length}`
            : '—'}
      </span>
    </div>
  );
}

export { STAGES };
