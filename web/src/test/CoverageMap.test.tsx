import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it } from 'vitest';
import type { IngestionReport } from '../api';
import CoverageMap from '../features/memory/CoverageMap';
import { citedPath, coverageTree, nodeAt, squarify, type Rect } from '../features/memory/coverage';

const files = [
  { path: 'src/rules/a.ts', lines: 100 },
  { path: 'src/rules/b.ts', lines: 50 },
  { path: 'src/cli.ts', lines: 30 },
  { path: 'README.md', lines: 20 },
  { path: 'assets/logo.png', lines: null },
];

it('sums files and lines by directory and counts a record once for each directory it touches', () => {
  const root = coverageTree(files, [
    ['src/rules/a.ts#L10', 'src/rules/b.ts'],
    ['README.md'],
    ['gone/file.ts'],
  ]);
  expect([root.files, root.lines, root.records]).toEqual([5, 200, 3]);
  // Directories first, largest first; then files.
  expect(root.children.map((node) => node.name)).toEqual(['src', 'assets', 'README.md']);
  const source = nodeAt(root, 'src');
  expect([source.files, source.lines, source.records]).toEqual([3, 180, 1]);
  const rules = nodeAt(root, 'src/rules');
  expect([rules.path, rules.files, rules.lines, rules.records]).toEqual(['src/rules', 2, 150, 1]);
  expect(rules.children.map((node) => [node.name, node.file, node.records])).toEqual([
    ['a.ts', true, 1],
    ['b.ts', true, 1],
  ]);
  // A file of unknown size is counted as a file and adds no lines.
  expect([nodeAt(root, 'assets').files, nodeAt(root, 'assets').lines]).toEqual([1, 0]);
  expect(root.children.find((node) => node.name === 'README.md')?.records).toBe(1);
  // A path that is gone, or that names a file, falls back to the root instead of failing.
  expect(nodeAt(root, 'missing')).toBe(root);
  expect(nodeAt(root, 'README.md')).toBe(root);
  expect(citedPath('src/rules/a.ts#L10')).toBe('src/rules/a.ts');
});

it('lays out rectangles whose areas follow the values, inside the frame and without overlap', () => {
  const frame: Rect = { x: 0, y: 0, width: 6, height: 4 };
  const values = [6, 6, 4, 3, 2, 2, 1];
  const rects = squarify(values, frame);
  expect(rects).toHaveLength(values.length);
  rects.forEach((rect, index) => {
    expect(rect.width * rect.height).toBeCloseTo(values[index], 9);
    expect(rect.x).toBeGreaterThanOrEqual(-1e-9);
    expect(rect.y).toBeGreaterThanOrEqual(-1e-9);
    expect(rect.x + rect.width).toBeLessThanOrEqual(frame.width + 1e-9);
    expect(rect.y + rect.height).toBeLessThanOrEqual(frame.height + 1e-9);
    // Squarified: no sliver. The classic example stays under a 3:1 ratio.
    expect(Math.max(rect.width / rect.height, rect.height / rect.width)).toBeLessThan(3);
  });
  for (let a = 0; a < rects.length; a += 1)
    for (let b = a + 1; b < rects.length; b += 1) {
      const overlapX =
        Math.min(rects[a].x + rects[a].width, rects[b].x + rects[b].width) - Math.max(rects[a].x, rects[b].x);
      const overlapY =
        Math.min(rects[a].y + rects[a].height, rects[b].y + rects[b].height) -
        Math.max(rects[a].y, rects[b].y);
      expect(Math.min(overlapX, overlapY)).toBeLessThanOrEqual(1e-9);
    }
  expect(squarify([], frame)).toEqual([]);
  expect(squarify([1, 1], { ...frame, width: 0 }).every((rect) => rect.width === 0)).toBe(true);
});

const index = {
  version: 1,
  project_id: 'synthetic-project',
  source_commit: 'a41c9e2' + '0'.repeat(33),
  index_version: 1,
  snapshot_digest: 'b'.repeat(64),
  captured_at: '2026-11-13T10:00:00Z',
  files: files.map((file) => ({
    ...file,
    content_digest: 'c'.repeat(64),
    indexable: file.lines !== null,
    areas: [],
    kind: 'source_fact',
    validator: 'bounded_source_index_v1',
  })),
  total_files: 7,
  omitted_files: 2,
  changes: { added: [], changed: [], deleted: [] },
  previous_commit: null,
  validity: 'current_at_capture',
  untrusted: true,
} satisfies NonNullable<IngestionReport['latest']>;

it('says what would fill the map when the repository has not been indexed', () => {
  render(<CoverageMap index={null} items={[]} />);
  expect(screen.getByRole('heading', { name: 'The repository has not been read yet' })).toBeVisible();
  expect(screen.getByText(/makes no model call/)).toBeVisible();
});

it('shows the repository before any record exists and opens a directory from the map or the table', async () => {
  const user = userEvent.setup();
  render(<CoverageMap index={index} items={[]} />);
  expect(screen.getByRole('heading', { name: 'Repository map' })).toBeVisible();
  expect(screen.getByText(/5 files, 200 lines/)).toBeVisible();
  expect(screen.getByText(/2 files outside the bounded index are not shown/)).toBeVisible();
  const table = screen.getByRole('table', { name: 'Contents of the repository' });
  expect(
    within(table)
      .getAllByRole('row')
      .slice(1)
      .map((row) => row.textContent),
  ).toEqual(['src/31800', 'assets/100', 'README.md1200']);
  await user.click(screen.getByRole('button', { name: 'Open src: 3 files, 180 lines, 0 records' }));
  expect(screen.getByRole('table', { name: 'Contents of src' })).toBeVisible();
  expect(screen.getByRole('button', { name: 'src' })).toHaveAttribute('aria-current', 'location');
  await user.click(
    within(screen.getByRole('table', { name: 'Contents of src' })).getByRole('button', { name: 'rules/' }),
  );
  expect(
    within(screen.getByRole('table', { name: 'Contents of src/rules' })).getByText('a.ts'),
  ).toBeVisible();
  // A file is described, not opened.
  expect(screen.getByRole('img', { name: 'a.ts: 1 file, 100 lines, 0 records' })).toBeVisible();
  await user.click(screen.getByRole('button', { name: 'Repository' }));
  expect(screen.getByRole('table', { name: 'Contents of the repository' })).toBeVisible();
});

it('marks where records cite files and leaves out invalidated ones', () => {
  render(
    <CoverageMap
      index={index}
      items={[
        { id: 'm1', citations: ['src/rules/a.ts#L10'], invalidated_at: null },
        { id: 'm2', citations: ['src/cli.ts'], invalidated_at: null },
        { id: 'm3', citations: ['README.md'], invalidated_at: '2026-11-13T12:00:00Z' },
      ]}
    />,
  );
  expect(screen.getByRole('button', { name: 'Open src: 3 files, 180 lines, 2 records' })).toBeVisible();
  expect(screen.getByRole('img', { name: 'README.md: 1 file, 20 lines, 0 records' })).toBeVisible();
});
