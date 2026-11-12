import type { ReactNode } from 'react';
import { cn } from '../../lib/utils';

export interface Layer {
  id: string;
  name: string;
  scope: string;
  value: ReactNode;
  description: string;
  tone: string;
  highlight?: boolean;
}

/**
 * How the factory remembers, from one model call to the whole project. Each layer names where it
 * lives and how long it lasts, so growth in one layer is never read as improvement in another.
 */
export default function MemoryLayers({ layers }: { layers: Layer[] }) {
  return (
    <section aria-labelledby="memory-layers-title" className="@container/layers grid min-w-0 gap-2.5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="memory-layers-title" className="text-base font-semibold">
          How the factory remembers
        </h2>
        <span className="text-xs text-muted-foreground">
          Five layers, from a single model call to the whole project
        </span>
      </div>
      <ol className="-mx-1 grid snap-x auto-cols-[minmax(14rem,78%)] grid-flow-col gap-2 overflow-x-auto px-1 pb-1 @3xl/layers:mx-0 @3xl/layers:auto-cols-auto @3xl/layers:grid-flow-row @3xl/layers:grid-cols-5 @3xl/layers:gap-0 @3xl/layers:overflow-visible @3xl/layers:px-0 @3xl/layers:pb-0">
        {layers.map((layer, index) => (
          <li
            key={layer.id}
            className={cn(
              'grid min-w-0 snap-start content-start gap-1.5 border border-border bg-card px-3.5 py-3',
              'rounded-xl @3xl/layers:rounded-none @3xl/layers:border-r-0',
              index === 0 && '@3xl/layers:rounded-l-xl',
              index === layers.length - 1 && '@3xl/layers:rounded-r-xl @3xl/layers:border-r',
              layer.highlight && 'border-timeline-memory/45 bg-timeline-memory/8',
            )}
          >
            <span className="flex items-center justify-between gap-2">
              <strong className="text-sm font-semibold">{layer.name}</strong>
              <span className="rounded-full border border-border px-2 text-[0.6875rem] text-muted-foreground">
                {layer.scope}
              </span>
            </span>
            <span className="text-lg font-semibold tabular-nums" style={{ color: layer.tone }}>
              {layer.value}
            </span>
            <span className="text-xs leading-snug text-muted-foreground">{layer.description}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}
