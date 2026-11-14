import type {
  IngestionReport,
  MemoryDetail,
  MemoryGraph,
  MemoryListItem,
  MemoryRecallPage,
  MemoryReview,
} from '../api';

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
    invalidated_as: null,
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
        index_missing: false,
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
        index_missing: false,
        bytes: 402,
        created_at: '2026-11-11T08:00:00Z',
      },
    ],
  };
}

/** A repository index as ingestion records it: paths, sizes and digests, no content. */
export function repositoryIndex(): NonNullable<IngestionReport['latest']> {
  const files: [string, number | null][] = [
    ['src/pricing/tax/rules.py', 420],
    ['src/pricing/tax/regions.py', 180],
    ['src/pricing/catalog.py', 310],
    ['src/pricing/discount.py', 240],
    ['src/pricing/rounding.py', 120],
    ['src/pricing/__init__.py', 12],
    ['src/api/routes.py', 340],
    ['src/api/server.py', 260],
    ['src/api/schemas.py', 150],
    ['src/cli.py', 90],
    ['tests/test_tax.py', 330],
    ['tests/test_discount.py', 210],
    ['tests/test_rounding.py', 95],
    ['tests/conftest.py', 40],
    ['docs/pricing-rules.md', 220],
    ['docs/architecture.md', 160],
    ['scripts/seed.py', 70],
    ['.github/workflows/check.yml', 55],
    ['README.md', 85],
    ['pyproject.toml', 60],
    ['AGENTS.md', 45],
    ['assets/logo.png', null],
  ];
  return {
    version: 1,
    project_id: 'synthetic-project',
    source_commit: '5be10d7'.padEnd(40, '0'),
    index_version: 1,
    snapshot_digest: 'd'.repeat(64),
    captured_at: '2026-11-10T07:40:00Z',
    files: files.map(([path, lines]) => ({
      path,
      content_digest: 'e'.repeat(64),
      indexable: lines !== null,
      lines,
      areas: [],
      kind: 'source_fact',
      validator: 'bounded_source_index_v1',
    })),
    total_files: files.length,
    omitted_files: 0,
    changes: { added: [], changed: [], deleted: [] },
    previous_commit: null,
    validity: 'current_at_capture',
    untrusted: true,
  };
}

/** A statement read from the repository: no run, anchored to the indexed commit it was read at. */
export function repositoryStatement(overrides: Partial<MemoryListItem> = {}): MemoryListItem {
  return memoryItem({
    id: 'r31',
    content: 'AGENTS.md › Verify\nRun `pytest -q` and `ruff check` before a pull request.',
    source_commit: head,
    source_work_id: null,
    evidence_digest: 'd'.repeat(64),
    citations: ['AGENTS.md#L12'],
    active: false,
    approved_at: null,
    state: 'pending',
    proposed_by: { channel: 'repository', role: 'instructions', work_id: null },
    validity: {
      commit: head,
      state: 'unavailable',
      reason: 'not_active',
      changed_paths: [],
      checked_at: null,
    },
    recall_count: 0,
    last_recalled_at: null,
    link_counts: { cites: 1, supersedes: 0, related: 0, overlaps: 0 },
    ...overrides,
  });
}

type ReadSummary = NonNullable<IngestionReport['jobs'][number]['imported']>;

/** The ingestion report after one completed read of the repository. */
export function repositoryRead(imported: Partial<ReadSummary> | null = {}): IngestionReport {
  const index = repositoryIndex();
  return {
    version: 1,
    project_id: 'synthetic-project',
    latest: index,
    jobs: [
      {
        version: 1,
        id: 'synthetic-read',
        project_id: 'synthetic-project',
        index_version: 1,
        state: 'completed',
        source_commit: index.source_commit,
        expected_source_commit: null,
        created_at: '2026-11-10T07:39:00Z',
        finished_at: '2026-11-10T07:40:00Z',
        error_code: null,
        error_message: null,
        imported: imported && {
          proposed: 3,
          replaced: 0,
          unchanged: 0,
          declined: 0,
          withdrawn: 0,
          refused: 0,
          omitted: 0,
          ...imported,
        },
      },
    ],
  };
}
