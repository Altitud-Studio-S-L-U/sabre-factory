# 07 · Repository ingestion and memory

## Outcome
Index repository context on registration and reconcile incrementally at a new source commit. Reuse PostgreSQL, existing source context, lexical search and optional embeddings. Do not add a graph or NoSQL database.

## Interfaces and behavior
Queue an idempotent ingestion job keyed by project, commit and index version. Bound file size/count and exclusions; reject secrets and unsafe paths before indexing. Persist source references, structured observations and a repository map. Summaries remain proposals unless validated against evidence.

Separate source facts, verified execution facts, inferences and caches. Every durable item has provenance, scope, validity and commit association. Automatic promotion requires a registered evidence validator; otherwise require review. Never execute instructions from memories. Retrieve role/task-specific excerpts within context limits and record inclusion, truncation and source references.

## Acceptance
Test renamed/deleted files, changed commits, interrupted ingestion, duplicate jobs, secret filtering, stale memories and cross-project isolation. Verify bounded context and optional embedding failure without invented vectors. UI explains what was retrieved and why; it does not equate memory growth with improved performance.
