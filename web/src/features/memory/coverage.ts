/** A directory or a file of the repository index, with what memory says about it. */
export type CoverageNode = {
  name: string;
  /** Repository-relative path; empty for the root. */
  path: string;
  file: boolean;
  files: number;
  /** Lines of the files whose size is known. */
  lines: number;
  /** Records that cite at least one file here. */
  records: number;
  children: CoverageNode[];
};

export type IndexedFile = { path: string; lines: number | null };

/** The cited path of a citation written `path` or `path#L<line>`. */
export const citedPath = (citation: string) => citation.split('#')[0];

/**
 * The directory tree of an index. `citations` holds, for each record, the files it cites:
 * a record counts once for every directory that contains one of them.
 */
export function coverageTree(files: IndexedFile[], citations: string[][]): CoverageNode {
  const root: CoverageNode = {
    name: '',
    path: '',
    file: false,
    files: 0,
    lines: 0,
    records: 0,
    children: [],
  };
  const byPath = new Map<string, CoverageNode>([['', root]]);
  const child = (parent: CoverageNode, name: string, file: boolean) => {
    const path = parent.path ? `${parent.path}/${name}` : name;
    let node = byPath.get(path);
    if (!node) {
      node = { name, path, file, files: 0, lines: 0, records: 0, children: [] };
      byPath.set(path, node);
      parent.children.push(node);
    }
    return node;
  };
  for (const entry of files) {
    const parts = entry.path.split('/').filter(Boolean);
    if (!parts.length) continue;
    const trail = [root];
    parts.forEach((part, index) => trail.push(child(trail[index], part, index === parts.length - 1)));
    for (const node of trail) {
      node.files += 1;
      node.lines += entry.lines ?? 0;
    }
  }
  for (const record of citations) {
    const touched = new Set<CoverageNode>();
    for (const citation of record) {
      const parts = citedPath(citation).split('/').filter(Boolean);
      // A citation of a file outside the index still counts for the directories that exist.
      for (let depth = 0; depth <= parts.length; depth += 1) {
        const node = byPath.get(parts.slice(0, depth).join('/'));
        if (!node) break;
        touched.add(node);
      }
    }
    for (const node of touched) node.records += 1;
  }
  const order = (node: CoverageNode) => {
    node.children.sort(
      (a, b) => Number(a.file) - Number(b.file) || b.lines - a.lines || a.name.localeCompare(b.name),
    );
    node.children.forEach(order);
  };
  order(root);
  return root;
}

/** The node at a path, or the root when the path no longer exists (a new index, another project). */
export function nodeAt(root: CoverageNode, path: string): CoverageNode {
  let node = root;
  for (const part of path.split('/').filter(Boolean)) {
    const next = node.children.find((candidate) => candidate.name === part && !candidate.file);
    if (!next) return root;
    node = next;
  }
  return node;
}

export type Rect = { x: number; y: number; width: number; height: number };

/**
 * Squarified treemap (Bruls, Huizing and van Wijk): rectangles with areas proportional to
 * `values`, kept as close to squares as the order allows. Values must be positive and are laid
 * out in the order given, so pass them largest first.
 */
export function squarify(values: number[], rect: Rect): Rect[] {
  const total = values.reduce((sum, value) => sum + value, 0);
  if (!values.length || total <= 0 || rect.width <= 0 || rect.height <= 0)
    return values.map(() => ({ ...rect, width: 0, height: 0 }));
  const scale = (rect.width * rect.height) / total;
  const areas = values.map((value) => value * scale);
  const result: Rect[] = [];
  let free = { ...rect };
  let start = 0;
  // The worst aspect ratio of a row of areas laid along a side of the given length.
  const worst = (row: number[], side: number) => {
    const sum = row.reduce((acc, value) => acc + value, 0);
    const max = Math.max(...row);
    const min = Math.min(...row);
    return Math.max((side * side * max) / (sum * sum), (sum * sum) / (side * side * min));
  };
  while (start < areas.length) {
    const side = Math.min(free.width, free.height);
    let end = start + 1;
    while (
      end < areas.length &&
      worst(areas.slice(start, end + 1), side) <= worst(areas.slice(start, end), side)
    )
      end += 1;
    const row = areas.slice(start, end);
    const sum = row.reduce((acc, value) => acc + value, 0);
    const thickness = sum / side;
    let offset = 0;
    for (const area of row) {
      const length = area / thickness;
      result.push(
        free.width >= free.height
          ? { x: free.x, y: free.y + offset, width: thickness, height: length }
          : { x: free.x + offset, y: free.y, width: length, height: thickness },
      );
      offset += length;
    }
    free =
      free.width >= free.height
        ? { x: free.x + thickness, y: free.y, width: free.width - thickness, height: free.height }
        : { x: free.x, y: free.y + thickness, width: free.width, height: free.height - thickness };
    start = end;
  }
  return result;
}
