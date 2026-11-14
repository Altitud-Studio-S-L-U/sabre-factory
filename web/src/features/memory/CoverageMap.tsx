import { useMemo, useState } from 'react';
import { ChevronRight } from 'lucide-react';
import type { IngestionReport, MemoryItem } from '../../api';
import EmptyState from '../../components/EmptyState';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../../components/ui/table';
import { useMediaQuery } from '../../lib/useMediaQuery';
import { cn } from '../../lib/utils';
import { coverageTree, nodeAt, squarify, type CoverageNode } from './coverage';

/** Drawing units. A phone gets a narrower canvas, so labels keep their size instead of shrinking with it. */
const WIDE = { width: 1000, height: 420 };
const NARROW = { width: 360, height: 380 };
/** Cells beyond this many are merged into one, so the smallest stay readable in the table below. */
const MAX_CELLS = 24;
const MAX_ROWS = 60;
const count = new Intl.NumberFormat('en-US');
const plural = (value: number, noun: string, many = `${noun}s`) =>
  `${count.format(value)} ${value === 1 ? noun : many}`;

type Cell = {
  key: string;
  node?: CoverageNode;
  label: string;
  lines: number;
  files: number;
  records: number;
};

/**
 * The repository as the index recorded it, by directory: how large each part is and how many
 * memory records cite files in it. It shows the project before any record exists.
 */
export default function CoverageMap({
  index,
  items,
}: {
  index: IngestionReport['latest'] | undefined;
  items: Pick<MemoryItem, 'id' | 'citations' | 'invalidated_at'>[];
}) {
  const [path, setPath] = useState('');
  const frame = useMediaQuery('(max-width: 40rem)') ? NARROW : WIDE;
  const root = useMemo(
    () =>
      index
        ? coverageTree(
            index.files,
            items.filter((item) => !item.invalidated_at).map((item) => item.citations),
          )
        : null,
    [index, items],
  );
  if (!index || !root)
    return (
      <EmptyState as="h2" title="The repository has not been read yet">
        Reading indexes the file paths, sizes and manifests of the default branch and makes no model call. Use
        Read the repository above; the map appears when it finishes.
      </EmptyState>
    );
  const current = nodeAt(root, path);
  const trail = current.path ? current.path.split('/') : [];
  const shown = current.children.slice(0, MAX_CELLS - 1);
  const rest = current.children.slice(MAX_CELLS - 1);
  const cells: Cell[] = shown.map((node) => ({
    key: node.path,
    node,
    label: node.name,
    lines: node.lines,
    files: node.files,
    records: node.records,
  }));
  if (rest.length === 1) {
    const [node] = rest;
    cells.push({
      key: node.path,
      node,
      label: node.name,
      lines: node.lines,
      files: node.files,
      records: node.records,
    });
  } else if (rest.length > 1)
    cells.push({
      key: ':rest',
      label: `${rest.length} smaller entries`,
      lines: rest.reduce((sum, node) => sum + node.lines, 0),
      files: rest.reduce((sum, node) => sum + node.files, 0),
      records: 0,
    });
  // Area follows the line count; an entry of unknown or zero size still gets a visible cell.
  const sized = [...cells].sort((a, b) => b.lines - a.lines);
  const floor = Math.max(1, sized.reduce((sum, cell) => sum + cell.lines, 0) / 200);
  const rects = squarify(
    sized.map((cell) => Math.max(cell.lines, floor)),
    { x: 0, y: 0, ...frame },
  );
  const rows = current.children.slice(0, MAX_ROWS);
  return (
    <section className="grid min-w-0 gap-4" aria-labelledby="coverage-map-title">
      <div className="grid min-w-0 gap-1">
        <h2 id="coverage-map-title" className="text-lg font-semibold">
          Repository map
        </h2>
        <p className="text-sm text-muted-foreground">
          The repository as indexed at{' '}
          <code className="font-mono text-xs">{index.source_commit.slice(0, 12)}</code>:{' '}
          {plural(root.files, 'file')}, {plural(root.lines, 'line')}. Area follows the line count, and a mark
          shows where memory records cite files.
          {index.omitted_files > 0 &&
            ` ${plural(index.omitted_files, 'file')} outside the bounded index ${index.omitted_files === 1 ? 'is' : 'are'} not shown.`}
        </p>
      </div>
      <nav aria-label="Directory" className="flex min-w-0 flex-wrap items-center gap-1 text-sm">
        <button
          type="button"
          className="cursor-pointer rounded px-1.5 py-0.5 font-medium text-link underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-default disabled:text-foreground disabled:no-underline"
          disabled={!trail.length}
          aria-current={!trail.length ? 'location' : undefined}
          onClick={() => setPath('')}
        >
          Repository
        </button>
        {trail.map((part, depth) => {
          const target = trail.slice(0, depth + 1).join('/');
          const last = depth === trail.length - 1;
          return (
            <span key={target} className="inline-flex items-center gap-1">
              <ChevronRight className="size-3.5 text-muted-foreground" aria-hidden="true" />
              <button
                type="button"
                className="cursor-pointer rounded px-1.5 py-0.5 font-mono text-xs text-link underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-default disabled:text-foreground disabled:no-underline"
                disabled={last}
                aria-current={last ? 'location' : undefined}
                onClick={() => setPath(target)}
              >
                {part}
              </button>
            </span>
          );
        })}
      </nav>
      {current.children.length === 0 ? (
        <p className="text-sm text-muted-foreground">This directory has no indexed files.</p>
      ) : (
        <>
          <figure className="m-0 min-w-0">
            <svg
              viewBox={`0 0 ${frame.width} ${frame.height}`}
              className="block h-auto w-full rounded-lg border border-border bg-card"
              role="group"
              aria-label={`Map of ${current.path || 'the repository'}: ${plural(current.children.length, 'entry', 'entries')}`}
            >
              {sized.map((cell, position) => {
                const rect = rects[position];
                const directory = !!cell.node && !cell.node.file;
                const roomy = rect.width > 96 && rect.height > 40;
                const label = `${cell.label}: ${plural(cell.files, 'file')}, ${plural(cell.lines, 'line')}, ${plural(cell.records, 'record')}`;
                return (
                  <g
                    key={cell.key}
                    role={directory ? 'button' : 'img'}
                    tabIndex={directory ? 0 : undefined}
                    aria-label={directory ? `Open ${label}` : label}
                    className={cn(
                      'outline-none',
                      directory &&
                        'cursor-pointer [&:focus-visible>rect]:stroke-ring [&:focus-visible>rect]:stroke-[3]',
                    )}
                    onClick={directory ? () => setPath(cell.node!.path) : undefined}
                    onKeyDown={
                      directory
                        ? (event) => {
                            if (event.key === 'Enter' || event.key === ' ') {
                              event.preventDefault();
                              setPath(cell.node!.path);
                            }
                          }
                        : undefined
                    }
                  >
                    <title>{label}</title>
                    <rect
                      x={rect.x + 1.5}
                      y={rect.y + 1.5}
                      width={Math.max(0, rect.width - 3)}
                      height={Math.max(0, rect.height - 3)}
                      rx={6}
                      className={cn(
                        'stroke-border',
                        directory ? 'fill-accent hover:fill-hover' : 'fill-secondary',
                        !cell.node && 'fill-transparent [stroke-dasharray:4_4]',
                      )}
                    />
                    {roomy && (
                      <>
                        <text
                          x={rect.x + 12}
                          y={rect.y + 22}
                          className="fill-foreground text-[13px] font-medium"
                        >
                          {cell.label.length > rect.width / 8
                            ? `${cell.label.slice(0, Math.max(3, Math.floor(rect.width / 8) - 1))}…`
                            : cell.label}
                          {directory ? '/' : ''}
                        </text>
                        <text x={rect.x + 12} y={rect.y + 38} className="fill-muted-foreground text-[12px]">
                          {count.format(cell.lines)} lines
                        </text>
                      </>
                    )}
                    {cell.records > 0 && rect.width > 30 && rect.height > 24 && (
                      <g aria-hidden="true">
                        <circle
                          cx={rect.x + rect.width - 16}
                          cy={rect.y + 16}
                          r={9}
                          className="fill-[var(--timeline-memory)]"
                        />
                        <text
                          x={rect.x + rect.width - 16}
                          y={rect.y + 20}
                          textAnchor="middle"
                          className="fill-background text-[12px] font-semibold"
                        >
                          {cell.records > 9 ? '9+' : cell.records}
                        </text>
                      </g>
                    )}
                  </g>
                );
              })}
            </svg>
            <figcaption className="mt-2 text-xs text-muted-foreground">
              Directories open on click or Enter. The same figures are in the table below.
            </figcaption>
          </figure>
          <Table aria-label={`Contents of ${current.path || 'the repository'}`}>
            <TableHeader>
              <TableRow>
                <TableHead scope="col">Name</TableHead>
                <TableHead scope="col" className="text-right">
                  Files
                </TableHead>
                <TableHead scope="col" className="text-right">
                  Lines
                </TableHead>
                <TableHead scope="col" className="text-right">
                  Records citing it
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((node) => (
                <TableRow key={node.path}>
                  <TableCell className="[overflow-wrap:anywhere]">
                    {node.file ? (
                      <code className="font-mono text-xs">{node.name}</code>
                    ) : (
                      <button
                        type="button"
                        className="cursor-pointer rounded font-mono text-xs text-link underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                        onClick={() => setPath(node.path)}
                      >
                        {node.name}/
                      </button>
                    )}
                  </TableCell>
                  <TableCell className="text-right whitespace-nowrap tabular-nums">
                    {count.format(node.files)}
                  </TableCell>
                  <TableCell className="text-right whitespace-nowrap tabular-nums">
                    {count.format(node.lines)}
                  </TableCell>
                  <TableCell className="text-right whitespace-nowrap tabular-nums">
                    {count.format(node.records)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {current.children.length > MAX_ROWS && (
            <p className="text-xs text-muted-foreground">
              Showing the {MAX_ROWS} largest of {count.format(current.children.length)} entries.
            </p>
          )}
        </>
      )}
    </section>
  );
}
