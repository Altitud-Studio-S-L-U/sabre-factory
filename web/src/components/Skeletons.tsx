import type { ReactNode } from 'react';
import { cn } from '../lib/utils';
import { Skeleton } from './ui/skeleton';

/**
 * Loading placeholders that keep each screen's real layout, so content lands where the eye already
 * is. Each composite is one status region with a screen-reader label; the shapes are decorative.
 */

export function SkeletonStatus({
  label,
  children,
  className,
}: {
  label: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      role="status"
      aria-busy="true"
      data-slot="skeleton"
      className={cn('@container grid min-w-0 gap-6', className)}
    >
      <span className="sr-only">{label}</span>
      {children}
    </div>
  );
}

/** Text lines of natural, varying lengths. */
export function SkeletonLines({ lines = 3, className }: { lines?: number; className?: string }) {
  const widths = ['w-11/12', 'w-4/5', 'w-2/3', 'w-3/4', 'w-1/2'];
  return (
    <div className={cn('grid gap-2', className)}>
      {Array.from({ length: lines }, (_, index) => (
        <Skeleton
          key={index}
          className={cn('h-3', index === lines - 1 ? 'w-2/5' : widths[index % widths.length])}
        />
      ))}
    </div>
  );
}

export function SkeletonPageHeader({ actions = 1 }: { actions?: number }) {
  return (
    <div className="flex min-w-0 flex-wrap items-start justify-between gap-4">
      <div className="flex min-w-0 flex-1 items-center gap-3.5">
        <Skeleton className="size-11 shrink-0 rounded-xl" />
        <div className="grid min-w-0 flex-1 gap-2">
          <Skeleton className="h-6 w-32" />
          <Skeleton className="h-3.5 w-full max-w-xl" />
          <Skeleton className="h-3.5 w-1/2 max-w-xs" />
        </div>
      </div>
      {actions > 0 && (
        <div className="flex gap-2">
          {Array.from({ length: actions }, (_, index) => (
            <Skeleton
              key={index}
              className={cn('h-10 rounded-md', index === actions - 1 ? 'w-28' : 'w-20')}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function SkeletonTiles({ count = 4 }: { count?: number }) {
  return (
    <div className="@container/stats">
      <div
        className={cn(
          'grid grid-cols-2 gap-3',
          count >= 5 ? '@2xl/stats:grid-cols-3 @5xl/stats:grid-cols-5' : '@2xl/stats:grid-cols-4',
        )}
      >
        {Array.from({ length: count }, (_, index) => (
          <div key={index} className="grid gap-2.5 rounded-xl border border-border bg-card px-4 py-3.5">
            <Skeleton className="h-3 w-20" />
            <Skeleton className="h-6 w-12" />
            <Skeleton className="h-3 w-28" />
          </div>
        ))}
      </div>
    </div>
  );
}

export function SkeletonSegmented({ count = 4 }: { count?: number }) {
  return (
    <div className="flex w-fit gap-1 rounded-lg border border-border bg-secondary/60 p-[3px]">
      {Array.from({ length: count }, (_, index) => (
        <Skeleton key={index} className={cn('h-8 rounded-md', index === 0 ? 'w-14' : 'w-20')} />
      ))}
    </div>
  );
}

export function SkeletonTabs({ count = 5 }: { count?: number }) {
  const widths = ['w-24', 'w-12', 'w-24', 'w-20', 'w-16', 'w-28', 'w-14'];
  return (
    <div className="flex gap-6 border-b border-border pb-3">
      {Array.from({ length: count }, (_, index) => (
        <Skeleton key={index} className={cn('h-3.5', widths[index % widths.length])} />
      ))}
    </div>
  );
}

type Column = 'title' | 'badge' | 'strip' | 'meter' | 'text' | 'actions' | 'mono';

function Cell({ kind, row }: { kind: Column; row: number }) {
  switch (kind) {
    case 'title':
      return (
        <div className="grid gap-1.5">
          <Skeleton className={cn('h-3.5', row % 3 === 0 ? 'w-64' : row % 3 === 1 ? 'w-48' : 'w-56')} />
          <Skeleton className="h-3 w-36" />
        </div>
      );
    case 'badge':
      return <Skeleton className="h-6 w-24 rounded-full" />;
    case 'strip':
      return (
        <div className="grid gap-1.5">
          <div className="flex gap-[3px]">
            {Array.from({ length: 7 }, (_, index) => (
              <Skeleton key={index} className="h-1.5 w-5 rounded-full" />
            ))}
          </div>
          <Skeleton className="h-3 w-16" />
        </div>
      );
    case 'meter':
      return (
        <div className="grid gap-1.5">
          <Skeleton className="h-3 w-24" />
          <Skeleton className="h-1 w-24 rounded-full" />
        </div>
      );
    case 'actions':
      return (
        <div className="flex justify-end gap-1.5">
          <Skeleton className="h-8 w-16" />
          <Skeleton className="h-8 w-12" />
        </div>
      );
    case 'mono':
      return <Skeleton className="h-3 w-16" />;
    default:
      return <Skeleton className={cn('h-3', row % 2 ? 'w-20' : 'w-14')} />;
  }
}

/** A table with a header row and cells shaped like their real content. */
export function SkeletonTable({
  rows = 5,
  columns = ['title', 'badge', 'text', 'actions'],
}: {
  rows?: number;
  columns?: Column[];
}) {
  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card">
      <div
        className="grid items-center gap-4 border-b border-border bg-secondary/50 px-4 py-3"
        style={{
          gridTemplateColumns: columns
            .map((c) => (c === 'title' ? 'minmax(0,2fr)' : 'minmax(0,1fr)'))
            .join(' '),
        }}
      >
        {columns.map((column, index) => (
          <Skeleton key={index} className={cn('h-3 w-14', column === 'actions' && 'justify-self-end')} />
        ))}
      </div>
      {Array.from({ length: rows }, (_, row) => (
        <div
          key={row}
          className="grid items-center gap-4 border-b border-border px-4 py-3.5 last:border-b-0"
          style={{
            gridTemplateColumns: columns
              .map((c) => (c === 'title' ? 'minmax(0,2fr)' : 'minmax(0,1fr)'))
              .join(' '),
          }}
        >
          {columns.map((column, index) => (
            <Cell key={index} kind={column} row={row} />
          ))}
        </div>
      ))}
    </div>
  );
}

export function SkeletonCard({ rows = 3, className }: { rows?: number; className?: string }) {
  return (
    <div className={cn('grid gap-4 rounded-xl border border-border bg-card p-5', className)}>
      <div className="grid gap-2">
        <Skeleton className="h-4 w-40" />
        <Skeleton className="h-3 w-2/3" />
      </div>
      <div className="grid divide-y divide-border border-y border-border">
        {Array.from({ length: rows }, (_, index) => (
          <div key={index} className="grid grid-cols-[minmax(0,12rem)_minmax(0,1fr)] items-center gap-4 py-3">
            <Skeleton className="h-3 w-24" />
            <Skeleton className={cn('h-3', index % 2 ? 'w-1/3' : 'w-1/2')} />
          </div>
        ))}
      </div>
    </div>
  );
}

/** Rows with a round mark and two lines, like the specialist and connection lists. */
export function SkeletonList({ rows = 5 }: { rows?: number }) {
  return (
    <div className="grid gap-2">
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="flex items-center gap-3 rounded-lg border border-border bg-card p-3.5">
          <Skeleton className="size-8 shrink-0 rounded-full" />
          <div className="grid flex-1 gap-1.5">
            <Skeleton className={cn('h-3.5', index % 2 ? 'w-24' : 'w-32')} />
            <Skeleton className="h-3 w-28" />
          </div>
          <Skeleton className="size-2 rounded-full" />
        </div>
      ))}
    </div>
  );
}

function Toolbar() {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <SkeletonSegmented />
      <Skeleton className="ml-auto h-9 w-64 rounded-md" />
      <Skeleton className="h-9 w-36 rounded-md" />
    </div>
  );
}

export function RunsSkeleton() {
  return (
    <SkeletonStatus label="Loading runs…">
      <SkeletonPageHeader />
      <SkeletonTiles />
      <div className="grid gap-3">
        <Toolbar />
        <SkeletonTable rows={6} columns={['title', 'badge', 'strip', 'meter', 'text', 'actions']} />
      </div>
    </SkeletonStatus>
  );
}

/** Timeline rows: a label column and bars at different offsets, like a recorded process. */
function TimelineRows({ rows = 5 }: { rows?: number }) {
  const bars = [
    ['left-[2%]', 'w-[12%]'],
    ['left-[14%]', 'w-[22%]'],
    ['left-[36%]', 'w-[30%]'],
    ['left-[66%]', 'w-[14%]'],
    ['left-[80%]', 'w-[16%]'],
  ];
  return (
    <div className="grid">
      {Array.from({ length: rows }, (_, index) => (
        <div
          key={index}
          className="grid grid-cols-[11rem_minmax(0,1fr)] border-b border-border last:border-b-0"
        >
          <div className="grid gap-1.5 border-r border-border px-4 py-3.5">
            <Skeleton className="h-3.5 w-20" />
            <Skeleton className="h-3 w-24" />
          </div>
          <div className="relative min-h-16">
            <Skeleton
              className={cn(
                'absolute top-4 h-[30px] rounded-md',
                bars[index % bars.length][0],
                bars[index % bars.length][1],
              )}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

export function RunDetailSkeleton() {
  return (
    <SkeletonStatus label="Loading run…" className="gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <Skeleton className="h-3 w-10" />
        <Skeleton className="h-3 w-24" />
        <Skeleton className="h-3 w-12" />
        <Skeleton className="h-5 w-16 rounded-full" />
        <Skeleton className="h-3 w-32" />
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Skeleton className="h-7 w-64" />
          <Skeleton className="h-6 w-28 rounded-full" />
        </div>
        <div className="flex gap-2">
          <Skeleton className="h-8 w-16" />
          <Skeleton className="h-8 w-24" />
        </div>
      </div>
      <SkeletonLines lines={2} className="max-w-2xl" />
      <SkeletonTabs />
      <div className="grid grid-cols-2 overflow-hidden rounded-xl border border-border bg-card @3xl:grid-cols-5">
        {Array.from({ length: 5 }, (_, index) => (
          <div key={index} className="grid gap-2 border-r border-border px-4 py-3 last:border-r-0">
            <Skeleton className="h-3 w-20" />
            <Skeleton className="h-4 w-14" />
            <Skeleton className="h-3 w-24" />
          </div>
        ))}
      </div>
      <div className="grid overflow-hidden rounded-xl border border-border bg-card @5xl:grid-cols-[minmax(0,1fr)_24rem]">
        <div className="min-w-0">
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <Skeleton className="h-4 w-28" />
            <div className="flex gap-2">
              <Skeleton className="h-8 w-20" />
              <Skeleton className="h-8 w-24" />
            </div>
          </div>
          <TimelineRows />
        </div>
        <div className="hidden content-start gap-4 overflow-hidden border-l border-border p-4 @5xl:grid">
          <div className="flex items-center gap-3">
            <Skeleton className="size-9 rounded-full" />
            <Skeleton className="h-4 w-28" />
          </div>
          <SkeletonTabs count={4} />
          <SkeletonLines lines={5} />
        </div>
      </div>
    </SkeletonStatus>
  );
}

/** Stage bands over station cards, shaped like the Agents production line. */
export function ProductionLineSkeleton({ stations = 11 }: { stations?: number }) {
  return (
    <div role="status" aria-busy="true" className="grid gap-4">
      <span className="sr-only">Loading the production line…</span>
      <div className="overflow-hidden rounded-xl border border-border bg-card p-3">
        <div
          className="grid gap-2.5"
          style={{ gridTemplateColumns: `repeat(${stations}, minmax(5.75rem, 1fr))` }}
        >
          {[3, 2, 1, 4, 1].map((span, index) => (
            <Skeleton
              key={index}
              className="h-6 rounded-t-lg rounded-b-none"
              style={{ gridColumn: `span ${span}` }}
            />
          ))}
          {Array.from({ length: stations }, (_, index) => (
            <div
              key={index}
              className="grid min-h-28 content-start gap-2 rounded-lg border border-border p-2.5"
            >
              <Skeleton className="size-[1.875rem] rounded-full" />
              <Skeleton className="h-3.5 w-16" />
              <Skeleton className="h-3 w-12" />
              <Skeleton className="h-2.5 w-10" />
            </div>
          ))}
          <Skeleton className="h-9 rounded-lg" style={{ gridColumn: `1 / ${stations + 1}` }} />
        </div>
      </div>
      <div className="grid gap-6 rounded-xl border border-border bg-card p-4 @4xl:grid-cols-2">
        <div className="grid content-start gap-3">
          <Skeleton className="h-3 w-24" />
          <Skeleton className="h-5 w-32" />
          <SkeletonLines lines={4} />
        </div>
        <div className="grid content-start gap-2">
          <Skeleton className="h-3 w-40" />
          {Array.from({ length: 4 }, (_, index) => (
            <Skeleton key={index} className="h-7 w-full" />
          ))}
        </div>
      </div>
    </div>
  );
}

export function AgentsSkeleton() {
  return (
    <SkeletonStatus label="Loading agents…">
      <SkeletonPageHeader actions={0} />
      <SkeletonTiles />
      <div className="flex items-end justify-between gap-3">
        <div className="grid gap-1.5">
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-3 w-72" />
        </div>
        <SkeletonSegmented />
      </div>
      <ProductionLineSkeleton />
    </SkeletonStatus>
  );
}

/** A focused memory with a ring of links, shaped like the knowledge map. */
export function KnowledgeMapSkeleton() {
  const ring = Array.from({ length: 6 }, (_, index) => {
    const angle = -Math.PI / 2 + (index / 6) * 2 * Math.PI;
    return { x: 430 + 140 * Math.cos(angle), y: 260 + 140 * Math.sin(angle) };
  });
  return (
    <div role="status" aria-busy="true" className="overflow-hidden rounded-xl border border-border">
      <span className="sr-only">Drawing the knowledge map…</span>
      <svg
        viewBox="0 0 860 520"
        aria-hidden="true"
        className="block h-auto w-full animate-pulse motion-reduce:animate-none"
      >
        {ring.map((point, index) => (
          <line
            key={`l${index}`}
            x1={430}
            y1={260}
            x2={point.x}
            y2={point.y}
            stroke="var(--border)"
            strokeWidth={1.5}
          />
        ))}
        <circle cx={430} cy={260} r={34} fill="var(--muted-bg)" />
        <rect x={350} y={306} width={160} height={10} rx={5} fill="var(--muted-bg)" />
        {ring.map((point, index) => (
          <g key={`n${index}`}>
            <circle cx={point.x} cy={point.y} r={13} fill="var(--muted-bg)" />
            <rect
              x={point.x + (point.x >= 430 ? 22 : -102)}
              y={point.y - 5}
              width={80}
              height={9}
              rx={4.5}
              fill="var(--muted-bg)"
            />
          </g>
        ))}
      </svg>
    </div>
  );
}

export function InspectorSkeleton() {
  return (
    <div
      role="status"
      aria-busy="true"
      className="grid content-start gap-4 rounded-xl border border-border bg-card p-4"
    >
      <span className="sr-only">Loading…</span>
      <div className="flex items-center justify-between">
        <div className="flex gap-1.5">
          <Skeleton className="h-5 w-12 rounded-full" />
          <Skeleton className="h-5 w-20 rounded-full" />
        </div>
        <Skeleton className="h-3 w-10" />
      </div>
      <Skeleton className="h-20 w-full rounded-lg" />
      <div className="grid gap-2.5">
        {Array.from({ length: 4 }, (_, index) => (
          <div key={index} className="flex items-center gap-2.5">
            <Skeleton className="size-2.5 rounded-full" />
            <Skeleton className={cn('h-3', index % 2 ? 'w-40' : 'w-52')} />
          </div>
        ))}
      </div>
      <SkeletonLines lines={3} />
    </div>
  );
}

export function MemorySkeleton() {
  return (
    <SkeletonStatus label="Loading project memory…">
      <SkeletonPageHeader actions={2} />
      <div className="grid gap-1.5">
        <Skeleton className="h-3 w-14" />
        <Skeleton className="h-10 w-80 max-w-full rounded-md" />
      </div>
      <SkeletonTiles count={5} />
      <div className="grid gap-2 @3xl:grid-cols-5">
        {Array.from({ length: 5 }, (_, index) => (
          <div key={index} className="grid gap-2 rounded-xl border border-border bg-card px-3.5 py-3">
            <div className="flex justify-between">
              <Skeleton className="h-3.5 w-16" />
              <Skeleton className="h-4 w-14 rounded-full" />
            </div>
            <Skeleton className="h-5 w-20" />
            <SkeletonLines lines={2} />
          </div>
        ))}
      </div>
      <SkeletonTabs count={7} />
      <div className="grid items-start gap-4 @5xl:grid-cols-[minmax(0,1fr)_22rem]">
        <KnowledgeMapSkeleton />
        <InspectorSkeleton />
      </div>
    </SkeletonStatus>
  );
}

export function ConfigSkeleton({ header = true }: { header?: boolean }) {
  return (
    <SkeletonStatus label="Loading the effective configuration…">
      {header && <SkeletonPageHeader actions={2} />}
      <div className="grid items-start gap-6 @5xl:grid-cols-[12.5rem_minmax(0,1fr)]">
        <div className="hidden gap-2.5 @5xl:grid">
          <Skeleton className="h-2.5 w-28" />
          {Array.from({ length: 5 }, (_, index) => (
            <Skeleton key={index} className={cn('h-3.5', index % 2 ? 'w-24' : 'w-32')} />
          ))}
          <Skeleton className="mt-3 h-2.5 w-16" />
          {Array.from({ length: 2 }, (_, index) => (
            <Skeleton key={`r${index}`} className="h-3.5 w-24" />
          ))}
        </div>
        <div className="grid gap-5">
          <div className="grid grid-cols-2 gap-2 @3xl:grid-cols-4">
            {Array.from({ length: 4 }, (_, index) => (
              <Skeleton key={index} className="h-10 rounded-md" />
            ))}
          </div>
          <div className="grid items-start gap-5 @5xl:grid-cols-[minmax(0,1.45fr)_minmax(18rem,1fr)]">
            <div className="grid gap-4 rounded-xl border border-border bg-card p-5">
              <Skeleton className="h-3 w-20" />
              <Skeleton className="h-5 w-48" />
              <SkeletonLines lines={2} />
              <div className="grid gap-1.5">
                <Skeleton className="h-3 w-24" />
                <Skeleton className="h-10 w-full rounded-md" />
              </div>
              <SkeletonLines lines={3} />
              <Skeleton className="h-10 w-40 rounded-md" />
            </div>
            <div className="grid gap-3 rounded-xl border border-border bg-card p-5">
              <Skeleton className="h-3 w-24" />
              <Skeleton className="h-5 w-44" />
              {Array.from({ length: 5 }, (_, index) => (
                <div key={index} className="grid gap-1.5">
                  <Skeleton className="h-3 w-16" />
                  <Skeleton className="h-3.5 w-32" />
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </SkeletonStatus>
  );
}

/** Header, figures and a table: the shape shared by Tools and the other sections. */
export function SectionSkeleton({ label = 'Loading section…' }: { label?: string }) {
  return (
    <SkeletonStatus label={label}>
      <SkeletonPageHeader />
      <SkeletonTiles />
      <SkeletonTabs count={4} />
      <SkeletonTable rows={4} columns={['title', 'badge', 'text', 'mono']} />
    </SkeletonStatus>
  );
}
