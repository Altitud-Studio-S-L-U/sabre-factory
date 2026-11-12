import type { MemoryDetail, MemoryGraph, MemoryListItem, MemoryRecallPage, MemoryReview } from '../api';

const commit = 'a41c9e2'.padEnd(40, '0');
const head = '5be10d7'.padEnd(40, '0');

export function memoryItem(overrides: Partial<MemoryListItem> = {}): MemoryListItem {
  return {
    id: 'm27',
    project_id: 'synthetic-project',
    kind: 'fact',
    content: "Discount uses banker's rounding: ROUND_HALF_EVEN to two places in apply_discount().",
    source_commit: commit,
    source_work_id: 'synthetic-run',
    evidence_digest: 'e'.repeat(64),
    scope: 'project',
    citations: ['src/pricing/discount.py'],
    supersedes: null,
    active: true,
    created_at: '2026-11-10T10:00:00Z',
    approved_at: '2026-11-10T18:42:00Z',
    invalidated_at: null,
    proposed_by: { channel: 'factory', role: 'developer', work_id: 'synthetic-run' },
    state: 'active',
    validity: {
      commit: head,
      state: 'valid',
      reason: 'citations_unchanged',
      changed_paths: [],
      checked_at: '2026-11-12T09:00:00Z',
    },
    recall_count: 14,
    last_recalled_at: '2026-11-12T08:00:00Z',
    link_counts: { cites: 1, supersedes: 1, related: 1, overlaps: 1 },
    ...overrides,
  };
}

export function memoryGraph(): MemoryGraph {
  return {
    focus: null,
    depth: 2,
    truncated: false,
    nodes: [
      {
        id: 'memory:m27',
        type: 'memory',
        label: "Discount uses banker's rounding",
        attrs: { kind: 'fact', state: 'active' },
      },
      {
        id: 'memory:p41',
        type: 'memory',
        label: 'Discount rounds half up',
        attrs: { kind: 'fact', state: 'pending' },
      },
      {
        id: 'memory:l05',
        type: 'memory',
        label: 'Seed the pricing suite before running it',
        attrs: { kind: 'lesson', state: 'active' },
      },
      {
        id: 'run:synthetic-run',
        type: 'run',
        label: 'Correct the synthetic example',
        attrs: { status: 'completed' },
      },
      { id: `commit:${commit}`, type: 'commit', label: commit.slice(0, 7), attrs: {} },
      { id: 'file:src/pricing/discount.py', type: 'file', label: 'src/pricing/discount.py', attrs: {} },
      { id: 'agent:factory:developer', type: 'agent', label: 'Factory · developer', attrs: {} },
    ],
    edges: [
      { source: 'memory:m27', target: 'run:synthetic-run', kind: 'from_run', attrs: {} },
      { source: 'run:synthetic-run', target: `commit:${commit}`, kind: 'at_commit', attrs: {} },
      { source: 'memory:m27', target: 'file:src/pricing/discount.py', kind: 'cites', attrs: {} },
      { source: 'memory:m27', target: 'agent:factory:developer', kind: 'proposed_by', attrs: {} },
      { source: 'memory:m27', target: 'memory:l05', kind: 'related', attrs: {} },
      { source: 'memory:p41', target: 'memory:m27', kind: 'overlaps', attrs: { score: 0.62 } },
    ],
  };
}

export function memoryDetail(item = memoryItem()): MemoryDetail {
  return {
    item,
    provenance: {
      work_id: 'synthetic-run',
      work_objective: 'Correct the synthetic example',
      work_status: 'completed',
      commit,
      evidence_digest: item.evidence_digest,
      proposed_by: item.proposed_by,
      approved_at: item.approved_at,
      invalidated_at: item.invalidated_at,
    },
    links: [
      {
        source_id: item.id,
        kind: 'related',
        target_type: 'memory',
        target_id: 'l05',
        attrs: {},
        created_at: '2026-11-10T18:42:00Z',
      },
    ],
    backlinks: [],
    validity_history: [],
    recalls: { recall_count: item.recall_count, last_recalled_at: item.last_recalled_at, refused_count: 1 },
  };
}

export function memoryReview(): MemoryReview {
  return {
    commit: head,
    truncated: false,
    pending: [
      {
        item: memoryItem({
          id: 'p41',
          content: 'Percentage discounts round half up to two places, so 0.125 becomes 0.13.',
          active: false,
          approved_at: null,
          state: 'pending',
          proposed_by: { channel: 'supervisor_chat', role: null, work_id: null },
          recall_count: 0,
        }),
        overlaps: [
          {
            memory_id: 'm27',
            state: 'active',
            content: "Discount uses banker's rounding: ROUND_HALF_EVEN to two places in apply_discount().",
            score: 0.62,
            lexical: 0.62,
            cosine: null,
            only_this: ['half', 'up', '0.13'],
            only_other: ['round_half_even', "banker's"],
          },
        ],
      },
    ],
    stale: [
      {
        item: memoryItem({ id: 'm14', content: 'Rate limiter lives in limits.py', recall_count: 8 }),
        changed_paths: [{ path: 'src/limits.py', change: 'changed' }],
      },
    ],
  };
}

export function memoryRecalls(): MemoryRecallPage {
  return {
    next_cursor: null,
    items: [
      {
        id: 'r2',
        project_id: 'synthetic-project',
        work_id: 'synthetic-run',
        role: 'qa',
        stage: 'verification',
        commit: head,
        outcome: 'recalled',
        error_code: null,
        query_terms: ['discount', 'rounding', 'cents'],
        candidates: 3,
        selected: [
          {
            memory_id: 'm27',
            lexical_rank: 1,
            vector_rank: 2,
            fused_score: 0.032,
            bytes: 612,
            truncated: false,
          },
          {
            memory_id: 'l05',
            lexical_rank: 2,
            vector_rank: null,
            fused_score: 0.016,
            bytes: 592,
            truncated: false,
          },
        ],
        omitted: 0,
        refused_memory_ids: [],
        bytes: 1204,
        created_at: '2026-11-12T08:00:00Z',
      },
      {
        id: 'r1',
        project_id: 'synthetic-project',
        work_id: 'synthetic-run',
        role: 'developer',
        stage: 'implementation',
        commit: head,
        outcome: 'refused',
        error_code: 'MEMORY_CONTEXT_CHANGED',
        query_terms: ['discount', 'truncate'],
        candidates: 1,
        selected: [],
        omitted: 0,
        refused_memory_ids: ['m09'],
        bytes: 402,
        created_at: '2026-11-11T08:00:00Z',
      },
    ],
  };
}
