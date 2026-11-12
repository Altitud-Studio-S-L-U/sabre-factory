import { describe, expect, it } from 'vitest';
import { layoutGraph } from '../features/memory/graphLayout';

const size = { width: 800, height: 500 };

describe('knowledge map layout', () => {
  const nodes = [
    { id: 'm1', type: 'memory' },
    { id: 'run', type: 'run' },
    { id: 'commit', type: 'commit' },
    { id: 'file', type: 'file' },
    { id: 'm2', type: 'memory' },
    { id: 'test-file', type: 'file' },
    { id: 'island', type: 'memory' },
  ];
  const edges = [
    { source: 'm1', target: 'run' },
    { source: 'run', target: 'commit' },
    { source: 'm1', target: 'file' },
    { source: 'm1', target: 'm2' },
    { source: 'm2', target: 'test-file' },
  ];

  it('centres the focus, rings its links and places second-degree links outside', () => {
    const placed = layoutGraph(nodes, edges, 'm1', size);
    expect(placed.get('m1')).toMatchObject({ x: 400, y: 250, ring: 0 });
    expect(['run', 'file', 'm2'].map((id) => placed.get(id)!.ring)).toEqual([1, 1, 1]);
    expect(placed.get('commit')!.ring).toBe(2);
    expect(placed.get('test-file')!.ring).toBe(2);
    expect(placed.get('island')!.ring).toBe(2);
    // Runs open the first ring at the top.
    expect(placed.get('run')!.y).toBeLessThan(250);
  });

  it('is deterministic and keeps every node inside the canvas', () => {
    const first = layoutGraph(nodes, edges, 'm1', size);
    const second = layoutGraph([...nodes].reverse(), [...edges].reverse(), 'm1', size);
    expect([...second.entries()].sort()).toEqual([...first.entries()].sort());
    for (const node of first.values()) {
      expect(node.x).toBeGreaterThanOrEqual(0);
      expect(node.x).toBeLessThanOrEqual(size.width);
      expect(node.y).toBeGreaterThanOrEqual(0);
      expect(node.y).toBeLessThanOrEqual(size.height);
    }
  });

  it('falls back to the first memory when no focus is given and handles an empty graph', () => {
    expect(layoutGraph(nodes, edges, null, size).get('m1')!.ring).toBe(0);
    expect(layoutGraph([], [], null, size).size).toBe(0);
  });
});
