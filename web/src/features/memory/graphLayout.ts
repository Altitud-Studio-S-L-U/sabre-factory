/**
 * Deterministic layout for the memory knowledge map. The focused memory sits at the centre;
 * its direct links form the first ring, grouped into sectors by node type, and second-degree
 * links sit on an outer ring next to the neighbour that reaches them. Same input, same picture:
 * no physics simulation, no randomness, no dependency.
 */

export interface LayoutNode {
  id: string;
  type: string;
}

export interface LayoutEdge {
  source: string;
  target: string;
}

export interface Placed {
  id: string;
  x: number;
  y: number;
  ring: 0 | 1 | 2;
}

/** Sector order around the focus, clockwise from the top. */
const SECTORS = ['run', 'commit', 'file', 'memory', 'agent'];

function sectorIndex(type: string) {
  const index = SECTORS.indexOf(type);
  return index < 0 ? SECTORS.length : index;
}

function neighbours(edges: LayoutEdge[], id: string) {
  const result = new Set<string>();
  for (const edge of edges) {
    if (edge.source === id) result.add(edge.target);
    if (edge.target === id) result.add(edge.source);
  }
  return result;
}

export function layoutGraph(
  nodes: LayoutNode[],
  edges: LayoutEdge[],
  focus: string | null,
  { width, height }: { width: number; height: number },
): Map<string, Placed> {
  const placed = new Map<string, Placed>();
  if (!nodes.length) return placed;
  const cx = width / 2;
  const cy = height / 2;
  const r1 = Math.min(width, height) * 0.26;
  const r2 = Math.min(width, height) * 0.42;
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const centre = (focus && byId.get(focus)) || nodes.find((node) => node.type === 'memory') || nodes[0];
  placed.set(centre.id, { id: centre.id, x: cx, y: cy, ring: 0 });

  // First ring: direct neighbours, sorted by sector then id, spread evenly from the top.
  const first = [...neighbours(edges, centre.id)]
    .map((id) => byId.get(id))
    .filter((node): node is LayoutNode => !!node && node.id !== centre.id)
    .sort((a, b) => sectorIndex(a.type) - sectorIndex(b.type) || a.id.localeCompare(b.id));
  const angleOf = new Map<string, number>();
  first.forEach((node, index) => {
    const angle = -Math.PI / 2 + (index / Math.max(first.length, 1)) * 2 * Math.PI;
    angleOf.set(node.id, angle);
    placed.set(node.id, { id: node.id, x: cx + r1 * Math.cos(angle), y: cy + r1 * Math.sin(angle), ring: 1 });
  });

  // Second ring: each remaining node next to the first neighbour that reaches it.
  const step = first.length ? (2 * Math.PI) / first.length : 2 * Math.PI;
  const children = new Map<string, string[]>();
  const orphans: string[] = [];
  for (const node of [...nodes].sort((a, b) => a.id.localeCompare(b.id))) {
    if (placed.has(node.id)) continue;
    const parent = first.find((candidate) => neighbours(edges, candidate.id).has(node.id));
    if (parent) children.set(parent.id, [...(children.get(parent.id) ?? []), node.id]);
    else orphans.push(node.id);
  }
  for (const [parent, ids] of children) {
    const base = angleOf.get(parent)!;
    ids.forEach((id, index) => {
      const spread = step * 0.7;
      const angle = base + (ids.length === 1 ? 0 : -spread / 2 + (index / (ids.length - 1)) * spread);
      placed.set(id, { id, x: cx + r2 * Math.cos(angle), y: cy + r2 * Math.sin(angle), ring: 2 });
    });
  }
  // Nodes with no path through the first ring share the outer ring's free arc at the bottom.
  orphans.forEach((id, index) => {
    const angle = Math.PI / 2 + (index - (orphans.length - 1) / 2) * 0.35;
    placed.set(id, { id, x: cx + r2 * Math.cos(angle), y: cy + r2 * Math.sin(angle), ring: 2 });
  });
  return placed;
}
