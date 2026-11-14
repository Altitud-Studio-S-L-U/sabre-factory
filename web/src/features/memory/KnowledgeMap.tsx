import { useEffect, useMemo, useState } from 'react';
import type { Api, MemoryGraph } from '../../api';
import EmptyState from '../../components/EmptyState';
import { KnowledgeMapSkeleton } from '../../components/Skeletons';
import Notice from '../../components/Notice';
import SegmentedControl from '../../components/SegmentedControl';
import { cn } from '../../lib/utils';
import { layoutGraph } from './graphLayout';
import { message } from '../runs/shared';

type Node = MemoryGraph['nodes'][number];
type Edge = MemoryGraph['edges'][number];

const WIDTH = 860;
const HEIGHT = 520;

/** Edge styles by relation, so each kind reads by line style as well as colour. */
const edgeStyles: Record<Edge['kind'], { stroke: string; dash?: string; label: string }> = {
  cites: { stroke: 'var(--color-muted-foreground)', label: 'cites' },
  supersedes: { stroke: 'var(--neutral)', dash: '6 4', label: 'supersedes' },
  related: { stroke: 'var(--timeline-memory)', label: 'related' },
  overlaps: { stroke: 'var(--timeline-failure)', dash: '4 4', label: 'overlaps' },
  from_run: { stroke: 'var(--info)', label: 'derived from' },
  at_commit: { stroke: 'var(--border)', label: 'at' },
  proposed_by: { stroke: 'var(--success)', dash: '2 3', label: 'proposed by' },
};

function memoryTone(node: Node) {
  const state = node.attrs.state;
  if (state === 'invalidated') return 'var(--neutral)';
  return node.attrs.kind === 'lesson' ? 'var(--timeline-memory)' : 'var(--primary)';
}

function truncate(value: string, size: number) {
  return value.length > size ? `${value.slice(0, size - 1)}…` : value;
}

export const memoryNodeId = (id: string) => `memory:${id}`;

function Shape({ node, focused }: { node: Node; focused: boolean }) {
  if (node.type === 'memory') {
    const pending = node.attrs.state === 'pending';
    const tone = memoryTone(node);
    const r = focused ? 22 : 13;
    return (
      <g>
        {focused && <circle r={32} fill={tone} opacity={0.18} />}
        <circle
          r={r}
          fill={pending ? 'var(--card)' : tone}
          fillOpacity={pending ? 1 : 0.9}
          stroke={tone}
          strokeWidth={pending ? 2 : 1.5}
          strokeDasharray={pending ? '4 3' : undefined}
        />
        {!pending && <circle r={r * 0.45} cx={-r * 0.3} cy={-r * 0.3} fill="white" opacity={0.25} />}
      </g>
    );
  }
  if (node.type === 'run')
    return (
      <rect
        x={-12}
        y={-12}
        width={24}
        height={24}
        rx={6}
        fill="var(--card)"
        stroke="var(--info)"
        strokeWidth={1.6}
      />
    );
  if (node.type === 'commit')
    return (
      <path
        d="M0 -11 L11 0 L0 11 L-11 0 Z"
        fill="var(--secondary)"
        stroke="var(--color-muted-foreground)"
        strokeWidth={1.4}
      />
    );
  if (node.type === 'file')
    return (
      <g>
        <rect
          x={-9}
          y={-12}
          width={18}
          height={24}
          rx={3}
          fill="var(--secondary)"
          stroke="var(--foreground)"
          strokeOpacity={0.6}
        />
        <path d="M-5 -5h10M-5 0h10M-5 5h6" stroke="var(--color-muted-foreground)" strokeWidth={1.2} />
      </g>
    );
  return <circle r={12} fill="var(--card)" stroke="var(--success)" strokeWidth={2} />;
}

/**
 * The project's knowledge as a map: memories with their run, commit, cited files, proposer and
 * links to other memories. Selecting a memory re-centres the map on it.
 */
export default function KnowledgeMap({
  api,
  projectId,
  focus,
  refreshKey,
  onFocus,
}: {
  api: Api;
  projectId: string;
  focus: string | null;
  refreshKey: number;
  onFocus: (memoryId: string | null) => void;
}) {
  const [depth, setDepth] = useState<'1' | '2'>('2');
  const [state, setState] = useState<{ key: string; graph?: MemoryGraph; error?: string } | null>(null);
  const key = `${projectId}|${focus}|${depth}|${refreshKey}`;
  useEffect(() => {
    let live = true;
    void api
      .memoryGraph(projectId, { focus: focus ?? undefined, depth: Number(depth), limit: 120 })
      .then((graph) => {
        if (!live) return;
        if (!Array.isArray(graph?.nodes) || !Array.isArray(graph?.edges))
          setState({ key, error: 'The server returned an unexpected knowledge map.' });
        else setState({ key, graph });
      })
      .catch((error: unknown) => live && setState({ key, error: message(error) }));
    return () => {
      live = false;
    };
  }, [api, projectId, focus, depth, key]);
  const current = state?.key === key ? state : null;
  const graph = current?.graph;
  const positions = useMemo(
    () =>
      graph
        ? layoutGraph(graph.nodes, graph.edges, focus ? memoryNodeId(focus) : null, {
            width: WIDTH,
            height: HEIGHT,
          })
        : new Map(),
    [graph, focus],
  );
  const centre = focus ? memoryNodeId(focus) : graph?.nodes.find((node) => node.type === 'memory')?.id;
  const kinds = [...new Set(graph?.edges.map((edge) => edge.kind) ?? [])];

  return (
    <div className="grid min-w-0 gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          {focus
            ? 'Centred on the selected memory. Select another memory to move through the map.'
            : 'Newest memories and everything they link to. Select a memory to centre on it.'}
        </p>
        <div className="flex items-center gap-2">
          {focus && (
            <button
              type="button"
              onClick={() => onFocus(null)}
              className="min-h-8 cursor-pointer rounded-md px-2.5 text-xs text-muted-foreground hover:bg-hover hover:text-foreground"
            >
              Show newest
            </button>
          )}
          <SegmentedControl
            label="Link depth"
            value={depth}
            onChange={setDepth}
            options={[
              { value: '1', label: 'Direct links' },
              { value: '2', label: 'Two steps' },
            ]}
          />
        </div>
      </div>
      {current?.error && (
        <Notice tone="danger" role="alert" title="The knowledge map could not be loaded.">
          <p>{current.error}</p>
        </Notice>
      )}
      {!current && <KnowledgeMapSkeleton />}
      {graph && !graph.nodes.length && (
        <EmptyState as="h3" title="Nothing to map yet">
          This map draws memories with the runs, commits and files they come from. A memory is recorded only
          when a run delivers a pull request; audits and runs that stop before delivery record nothing, so
          there is nothing to draw yet.
        </EmptyState>
      )}
      {graph && graph.nodes.length > 0 && (
        <figure className="m-0 grid min-w-0 gap-2">
          <div className="overflow-x-auto rounded-xl border border-border bg-[radial-gradient(ellipse_at_center,color-mix(in_oklch,var(--timeline-memory)_7%,transparent),transparent_70%)]">
            <svg
              viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
              className="block h-auto w-full min-w-[40rem]"
              role="group"
              aria-label={`Knowledge map with ${graph.nodes.length} nodes and ${graph.edges.length} links`}
            >
              {graph.edges.map((edge, index) => {
                const a = positions.get(edge.source);
                const b = positions.get(edge.target);
                if (!a || !b) return null;
                const style = edgeStyles[edge.kind];
                const near = edge.source === centre || edge.target === centre;
                return (
                  <g key={`${edge.source}-${edge.target}-${edge.kind}-${index}`}>
                    <line
                      x1={a.x}
                      y1={a.y}
                      x2={b.x}
                      y2={b.y}
                      stroke={style.stroke}
                      strokeWidth={near ? 1.6 : 1}
                      strokeOpacity={near ? 0.85 : 0.4}
                      strokeDasharray={style.dash}
                    />
                    {near && (
                      <text
                        x={(a.x + b.x) / 2}
                        y={(a.y + b.y) / 2 - 4}
                        textAnchor="middle"
                        fontSize={11}
                        fill="var(--color-muted-foreground)"
                        stroke="var(--background)"
                        strokeWidth={4}
                        strokeLinejoin="round"
                        style={{ paintOrder: 'stroke' }}
                      >
                        {style.label}
                      </text>
                    )}
                  </g>
                );
              })}
              {graph.nodes.map((node) => {
                const at = positions.get(node.id);
                if (!at) return null;
                const focused = node.id === centre;
                const memoryId = node.type === 'memory' ? node.id.slice('memory:'.length) : null;
                const label = truncate(node.label, focused ? 44 : node.type === 'memory' ? 30 : 26);
                // Labels sit where they collide least: below the centre, beside first-ring nodes and
                // outward from second-ring nodes.
                const side = at.x >= WIDTH / 2 ? 1 : -1;
                const placement =
                  at.ring === 0
                    ? { x: 0, y: 40, anchor: 'middle' as const }
                    : at.ring === 1
                      ? { x: side * 20, y: 4, anchor: side > 0 ? ('start' as const) : ('end' as const) }
                      : { x: 0, y: at.y < HEIGHT / 2 ? -19 : 27, anchor: 'middle' as const };
                const content = (
                  <>
                    <Shape node={node} focused={focused} />
                    <text
                      x={placement.x}
                      y={placement.y}
                      textAnchor={placement.anchor}
                      fontSize={focused ? 13 : 11.5}
                      fontWeight={focused ? 600 : 400}
                      fill={focused ? 'var(--foreground)' : 'var(--color-muted-foreground)'}
                      stroke="var(--background)"
                      strokeWidth={4}
                      strokeLinejoin="round"
                      style={{ paintOrder: 'stroke' }}
                      className={cn(node.type !== 'memory' && 'font-mono')}
                    >
                      {label}
                    </text>
                  </>
                );
                return memoryId ? (
                  <g
                    key={node.id}
                    transform={`translate(${at.x} ${at.y})`}
                    role="button"
                    tabIndex={0}
                    aria-label={`Memory: ${node.label}${focused ? ' (selected)' : ''}`}
                    aria-pressed={focused}
                    className="cursor-pointer outline-none [&:focus-visible>g>circle:last-of-type]:stroke-ring"
                    onClick={() => onFocus(memoryId)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        onFocus(memoryId);
                      }
                    }}
                  >
                    {content}
                  </g>
                ) : (
                  <g
                    key={node.id}
                    transform={`translate(${at.x} ${at.y})`}
                    aria-label={`${node.type}: ${node.label}`}
                  >
                    {content}
                  </g>
                );
              })}
            </svg>
          </div>
          <figcaption className="flex flex-wrap gap-x-4 gap-y-1.5 text-xs text-muted-foreground">
            <Legend swatch={<span className="size-3 rounded-full bg-primary" />}>Fact</Legend>
            <Legend swatch={<span className="size-3 rounded-full bg-timeline-memory" />}>Lesson</Legend>
            <Legend swatch={<span className="size-3 rounded-full border-2 border-dashed border-primary" />}>
              Pending
            </Legend>
            <Legend swatch={<span className="size-3 rounded-[3px] border-[1.5px] border-info" />}>Run</Legend>
            <Legend swatch={<span className="size-2.5 rotate-45 border-[1.5px] border-muted-foreground" />}>
              Commit
            </Legend>
            <Legend swatch={<span className="h-3 w-2.5 rounded-[2px] border-[1.5px] border-foreground/60" />}>
              File
            </Legend>
            <Legend swatch={<span className="size-3 rounded-full border-2 border-success" />}>
              Proposer
            </Legend>
            {kinds.length > 0 && (
              <span className="ml-auto">
                Links: {kinds.map((kind) => edgeStyles[kind].label).join(' · ')}
              </span>
            )}
            {graph.truncated && (
              <span className="basis-full text-warning">The map is bounded; some links are not drawn.</span>
            )}
          </figcaption>
        </figure>
      )}
    </div>
  );
}

function Legend({ swatch, children }: { swatch: React.ReactNode; children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span aria-hidden="true" className="grid size-3.5 place-items-center">
        {swatch}
      </span>
      {children}
    </span>
  );
}
