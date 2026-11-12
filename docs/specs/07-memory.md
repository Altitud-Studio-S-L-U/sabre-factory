# 07 · Repository ingestion and memory

## Outcome
Index repository context on registration and reconcile incrementally at a new source commit. Reuse PostgreSQL, existing source context, lexical search and optional embeddings. Do not add a graph or NoSQL database.

## Interfaces and behavior
Queue an idempotent ingestion job keyed by project, commit and index version. Bound file size/count and exclusions; reject secrets and unsafe paths before indexing. Persist source references, structured observations and a repository map. Summaries remain proposals unless validated against evidence.

Separate source facts, verified execution facts, inferences and caches. Every durable item has provenance, scope, validity and commit association. Automatic promotion requires a registered evidence validator; otherwise require review. Never execute instructions from memories. Retrieve role/task-specific excerpts within context limits and record inclusion, truncation and source references.

### Scope, validity and carry-forward
A memory is proposed with `scope` `commit` (default) or `project`. A commit-scoped memory is recalled only at its source commit; the delivery fact written by the `remember` node is always commit-scoped. A project-scoped approved memory is also recalled at another commit C when it is valid there:

- C must have a repository index at the current index version; otherwise the memory is not recallable at C (`index_missing`) and nothing is guessed or stored.
- Without citations the memory carries forward (`no_citations`).
- With citations, every cited path must exist in C's index with the content digest recorded at the memory's last valid commit (`citations_unchanged`). A changed digest or a missing path, including a rename, makes it `stale` at C with the changed paths (`citations_changed`). Stale memories are not recalled and appear in review.

Evaluations are stored in `memory_validity(project_id, memory_id, commit, state, basis, changed_paths, digests, checked_at)`: one automatic row per memory and commit plus at most one owner row. The owner can carry a stale memory forward to an indexed commit (`POST /api/v1/memory/{memory_id}/carry-forward`); this records basis `owner`, adopts the reviewed digests and drops deleted citations from the baseline. Invalidation stays final and wins over any validity record. Retrieval, the `read_memory` tool and the validator that revalidates cited memories before each model call all use validity at the run commit within one project, and memories remain untrusted data.

### Links
`memory_links(project_id, source_id, kind, target_type, target_id, attrs, created_at)` stores the graph as a relational table:

- `cites` → file path, with the digest and commit at proposal and optional lines. Citations are written `path` or `path#L<line>`, must be safe repository-relative paths and must exist in the index at the source commit.
- `supersedes` → memory of the same project, declared at proposal or approval; approval invalidates the older memory in the same transaction.
- `related` → memory, recorded by the owner on approval.
- `overlaps` → memory, recorded automatically (see below).

Edges to the source run, the source commit and the proposing entry point derive from memory fields. `GET /api/v1/projects/{project_id}/memory/graph` returns a bounded neighbourhood (`depth` 1 or 2, at most 300 nodes) and marks truncation.

### Attribution
`proposed_by {channel: owner_console | owner_mcp | supervisor_chat | factory, role?, work_id?}` is set by the server from the entry point and rejected in request bodies. Memories recorded earlier have no proposer and read as unknown.

### Overlap detection
Each proposal that does not activate itself is compared with the newest 500 active or pending memories of its project, excluding factory delivery facts. Lexical similarity is the mean of the Jaccard similarity of normalized word sets and of word 2-shingles (lower-cased words of two or more characters, minus a small English stop-word list). With embeddings on both sides, cosine similarity is also considered. A pair overlaps when lexical similarity is at least 0.4 or cosine similarity at least 0.92; at most ten links are stored with the score, both measures and up to twelve terms unique to each side. Overlap is not a conflict verdict: the owner decides, and can record `supersedes` or `related` on approval.

### Recall log
Each role context retrieval writes a `memory_recalls` row: run, role, stage, commit, up to 32 query terms, candidate and omitted counts, context bytes and, for each selected memory, its lexical rank, vector rank, reciprocal-rank-fusion score (sum of 1/(60+rank)), excerpt bytes and truncation. Validator refusals are recorded with the memory ids and error code. No memory content is copied into the log. The console reads it through `GET /api/v1/projects/{project_id}/memory/recalls`, and listings report per-memory recall counts.

### Console reads
`GET /api/v1/projects/{project_id}/memory/items` (cursor-paged, filtered by state, kind and text) reports validity at the project's newest indexed commit with its reason; `GET /api/v1/memory/{memory_id}` adds provenance, links, validity history and recall statistics; `GET /api/v1/projects/{project_id}/memory/review` lists pending proposals with overlaps and stale memories with changed files. The owner MCP mirrors the graph, recall and review reads as read-only tools; the delegated MCP surface has no memory tools.

## Acceptance
Test renamed/deleted files, changed commits, interrupted ingestion, duplicate jobs, secret filtering, stale memories and cross-project isolation. Verify bounded context and optional embedding failure without invented vectors. UI explains what was retrieved and why; it does not equate memory growth with improved performance.
