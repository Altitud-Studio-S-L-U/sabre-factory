# 17 · Memory that fills and shows itself

## Outcome
A project's memory is useful from the day the project is registered. The console shows what the factory knows about the repository, where each item came from, what the last run used and what needs a decision. Nothing reaches trusted memory unreviewed. This amends [07](07-memory.md); its provenance, validity, links, overlap detection and recall log stay.

## State it starts from
- Every record must cite a run that delivered a pull request. An audit never does, so an audit that completes records nothing, and neither does a run that stops. Specialists can read memory and cannot propose it.
- The one automatic record states how many checks passed at the pull-request commit. It is scoped to that commit, no later run starts from it, so it is never recalled, and it is not knowledge.
- The owner's Propose dialog prefills the base commit of the latest run, which the service refuses. A citation must exist in an index at the record's commit, and only the default branch is indexed, so file citations, staleness and carry-forward are unreachable for a delivered run.
- The first run on a new base commit recalls no project memory: the index it needs is requested after the run has taken the project.
- The repository index (paths, digests, line counts, area hints) feeds citation checks and a file list, nothing else.
- The map draws the provenance of one record. With no records it is blank, and the console never says what would fill it. The gallery fixtures show records the service cannot produce.
- The bench replaces memory with a stub, so whether recall helps a run has never been measured.

## What the evidence says
Coding-agent products have converged on plain, inspectable text with search, a small layer injected into every run, citations re-checked when a record is recalled and human review of what the agent wrote. Knowledge graphs extracted by a model pay off for multi-hop or temporal questions over long histories and cost extraction and upkeep; file-based memory with search matches or beats them on current benchmarks, and those benchmarks are weak. Generated repository overviews injected into every run have not been shown to raise task success. Memory is an attack surface: unreviewed agent output and imported instruction files must not become trusted by default.

## Interfaces and behavior
**Three sources, each with its own provenance.**

- *Repository.* When a commit is indexed, the service imports what the repository already says, with no model call: instruction files (`AGENTS.md`, `CLAUDE.md`, contribution guides) as proposals that cite the file, and the commands and stack declared in its manifests as proposals that cite the manifest line. Provenance is the commit and the index digest, with no run. A changed file proposes a replacement that shows the difference. Nothing here is generated prose.
- *Run.* The analyst, the developer and the reviewer may propose a bounded number of records through a tool, each a statement, its citations and the reason it matters. The service checks every citation against the run's snapshot and refuses a record whose files or lines do not exist. Provenance is the run, its base commit and the snapshot digest; delivery is no longer required, so an audit and a stopped run can leave what they established. A proposal is never active by itself.
- *Owner.* A proposal may cite any commit that has an index, not only a delivered run; the dialog offers those commits.

The delivery count stays in the run's evidence and is no longer written as a memory. The repair lesson of [07](07-memory.md) is unchanged.

**Indexes where records need them.** A delivery indexes its commit, so its citations validate. A run's base commit is indexed before the run takes the project. When nothing can be recalled because the commit has no index, the recall log says so.

**Safety.** An imported instruction file is untrusted data until the owner approves it, like any proposal. A record derived from model output is never promoted automatically. A project record that no run has recalled for a configured number of runs is listed for review instead of living forever. Secret refusal, overlap detection and the rule that memories are never executed as instructions apply to every source.

**Console, in order of value.**

1. A status line: records by state, the last write and the last recall. When memory is empty it names the cause and offers one action, Read the repository, which indexes and imports.
2. Used in the last run: what was recalled, for which specialist, from which source, and how the run ended.
3. The review queue with the evidence beside each proposal.
4. Records with provenance; a record's page shows its history and its links one step out. This is where the current map lives: a neighbourhood of one record, never the landing view.
5. A coverage map of the repository by directory, drawn from the index: size, the records that cite files there, and how many are stale. It shows the project before any record exists. The map with sizes and citing records is built and is the landing view until the status line and the last-run trace exist; staleness by directory is not.

The console claims nothing the service cannot do: no "hybrid retrieval" without embeddings, no Supervisor that proposes memories without a grant, and fixtures limited to what the service produces.

**Measurement.** The evaluation suite runs with memory on and off ([16](16-evaluation.md)). Recall has to earn its tokens.

## Not in scope
A knowledge graph extracted by a model, a graph database, and a generated overview of the repository injected into every run. The links of [07](07-memory.md) stay the only graph.

## Acceptance
A project that was only registered shows its coverage map and its imported instruction files waiting for review. An audit that reaches its report, and a run that stops, leave proposals with their provenance; a proposal citing a missing file or line is refused. The owner proposes a record against an indexed commit and it is accepted. A citation at a delivery commit validates and goes stale when the file changes. The first run on a new base commit recalls the project's valid records. Every empty state names its cause. The gallery renders only data the service produced in a test. A bench report compares runs with and without memory.
