import base64
import hashlib
import json
import re
from datetime import datetime

from pydantic import ValidationError

from sabre.memory_contracts import (
    MemoryApproval,
    MemoryCarryForward,
    MemoryDetail,
    MemoryGraph,
    MemoryItemPage,
    MemoryLink,
    MemoryLinkCounts,
    MemoryListItem,
    MemoryProvenance,
    MemoryRecall,
    MemoryRecallPage,
    MemoryRecallStats,
    MemoryReview,
    MemoryValidityAt,
    MemoryValidityRecord,
    OverlapEntry,
    PendingReview,
    StaleReview,
)
from sabre.memory_store import lifecycle
from sabre.models import (
    DomainError,
    MemoryCreate,
    MemoryItem,
    ProposedBy,
    WorkOrder,
    memory_identity,
    new_id,
    now,
)
from sabre.repository import digest

MAX_CONTEXT_BYTES = 6144
MAX_CONTEXT_ITEMS = 4
MAX_READ_CHARS = 2048
MAX_RECALL_TERMS = 32
REVIEW_LIMIT = 100

# What a run's own specialists may propose while they work. A proposal waits for the owner like any
# other; the bounds keep one run from flooding the review queue.
RUN_PROPOSERS = frozenset({"analyst", "developer", "reviewer"})
MAX_STEP_PROPOSALS = 3
MAX_RUN_PROPOSALS = 12
PROPOSE_TOOL = "propose_memory"
PROPOSE_DESCRIPTION = (
    "Propose one thing about this repository that a later run would otherwise have to rediscover: where a behaviour lives, "
    "a command that verifies it, a constraint that is not obvious. Give the statement, why it matters and the files that show it "
    "(a path, optionally with #L<line>) as they are at the commit this run started from. The owner reviews every proposal before "
    f"any run sees it. At most {MAX_STEP_PROPOSALS} per assignment. Not for task progress, plans or anything the cited files do not show."
)
PROPOSE_SCHEMA = {
    "type": "object",
    "properties": {
        "statement": {"type": "string", "minLength": 20, "maxLength": 1000},
        "why": {"type": "string", "minLength": 10, "maxLength": 300},
        "citations": {"type": "array", "items": {"type": "string", "minLength": 1, "maxLength": 1040},
                      "minItems": 1, "maxItems": 5, "uniqueItems": True},
        "kind": {"type": "string", "enum": ["fact", "lesson"]},
    },
    "required": ["statement", "why", "citations"],
    "additionalProperties": False,
}
PROPOSE_GUIDANCE = ("When you establish something about this repository that a later run would otherwise rediscover, propose it once "
                    "with propose_memory when that tool is listed. A refused proposal needs no retry: continue with the task.")
# Refusals a specialist can read and move on from. Anything else is a fault of the factory, not of the proposal.
PROPOSAL_REFUSALS = {
    "MEMORY_CITATION_UNKNOWN": "A cited file or line does not exist at the commit this run started from. Cite files as they were before any change of this run.",
    "MEMORY_INDEX_MISSING": "The commit this run started from has no repository index, so citations cannot be checked. Continue with the task.",
    "MEMORY_PROVENANCE": "The commit this run started from has no repository index, so the proposal cannot be anchored. Continue with the task.",
    "MEMORY_LINK_INVALID": "The proposal refers to a memory outside this project.",
}


def validity_at(item: MemoryItem, commit: str | None, record: dict | None) -> MemoryValidityAt:
    """Explain whether ``item`` would be recalled at ``commit`` from its scope and stored evaluation."""
    def result(state, reason, changed=(), checked=None):
        return MemoryValidityAt(commit=commit, state=state, reason=reason, changed_paths=list(changed), checked_at=checked)
    if not item.active or item.invalidated_at is not None:
        return result("unavailable", "not_active")
    if commit is None:
        return result("unavailable", "index_missing")
    if commit == item.source_commit:
        return result("valid", "source_commit", checked=item.approved_at)
    if item.scope != "project":
        return result("unavailable", "commit_scope")
    if record is None:
        return result("unavailable", "not_evaluated")
    return result(record["state"], record["basis"], record["changed_paths"], record["checked_at"])


def encode_cursor(item: MemoryItem) -> str:
    raw = json.dumps([item.created_at.isoformat(), item.id], separators=(",", ":")).encode()
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def decode_cursor(cursor: str | None) -> tuple[str, str] | None:
    if cursor is None:
        return None
    try:
        created_at, identifier = json.loads(base64.urlsafe_b64decode(cursor + "=" * (-len(cursor) % 4)))
        datetime.fromisoformat(created_at)
        if not isinstance(identifier, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", identifier):
            raise ValueError
    except (ValueError, TypeError):
        raise DomainError("INVALID_CURSOR", "Use the next_cursor of a previous page", 422) from None
    return created_at, identifier


def encoded_size(value):
    return len(json.dumps(value, ensure_ascii=False).encode())


def bounded_text(value: str, size: int) -> str:
    return value.encode()[:size].decode("utf-8", errors="ignore")


def memory_reference(item):
    return {"id": item.id, "project_id": item.project_id, "kind": item.kind, "content_digest": hashlib.sha256(item.content.encode()).hexdigest(),
            "source_commit": item.source_commit, "source_work_id": item.source_work_id,
            "evidence_digest": item.evidence_digest, "untrusted": True}


def memory_excerpt(item, query, limit):
    words = sorted(set(re.findall(r"[\w.-]{4,64}", query.casefold())), key=lambda word: (-len(word), word))
    start = next((max(0, item.content.casefold().find(word) - 120) for word in words if word in item.content.casefold()), 0)
    value = {**memory_reference(item), "content": item.content[start:start + 1024], "offset": start,
             "truncated": False, "next_offset": None}
    while True:
        end = start + len(value["content"])
        value.update(truncated=start > 0 or end < len(item.content), next_offset=end if end < len(item.content) else None)
        if encoded_size(value) <= limit:
            return value
        if not value["content"]:
            raise DomainError("MEMORY_CONTEXT_LIMIT", "Memory provenance exceeds the context limit")
        value["content"] = value["content"][:len(value["content"]) // 2]


def verified_fact(work) -> str:
    return f"Commit {work.evidence.commit}: {len(work.evidence.gates)} checks passed; snapshot {work.evidence.snapshot_digest}."


class MemoryService:
    def __init__(self, repository, guard, embeddings=None):
        self.repository = repository
        self.guard = guard
        self.embeddings = embeddings

    async def propose(self, request: MemoryCreate, *, proposed_by: ProposedBy | None = None) -> MemoryItem:
        """``proposed_by`` names the calling entry point; it is never taken from the request body."""
        self.guard.check(request.model_dump())
        verifiable = False
        if request.source_work_id is None:
            # Without a run the anchor is a commit the factory indexed for this project; its snapshot is the evidence.
            indexed = await self.repository.repository_index_digest(request.project_id, request.source_commit)
            if indexed is None or request.evidence_digest not in (None, indexed):
                raise DomainError("MEMORY_PROVENANCE", "Provenance must be a delivery of this project or one of its indexed commits")
            request = request.model_copy(update={"evidence_digest": indexed})
        else:
            work = await self.repository.work(request.source_work_id)
            if work.project_id != request.project_id:
                raise DomainError("MEMORY_PROVENANCE", "Provenance does not match a project delivery")
            if work.evidence and work.evidence.commit == request.source_commit:
                # Recovery may queue a published order before replaying its final memory write.
                delivered = work.status == "completed" or bool(work.evidence.branch and work.evidence.pr_url)
                # Only the mechanically derived delivery fact activates itself, and it stays commit-scoped.
                verifiable = (request.kind == "fact" and delivered and request.content == verified_fact(work)
                              and request.evidence_digest == work.evidence.snapshot_digest and request.scope == "commit"
                              and not request.citations and request.supersedes is None)
            else:
                # A run's own specialists record what they established at the commit the run started from, whether
                # or not it delivers. Intake indexed that commit; its snapshot is the evidence.
                from_run = (proposed_by is not None and proposed_by.channel == "factory" and proposed_by.work_id == work.id
                            and proposed_by.role in RUN_PROPOSERS)
                indexed = await self.repository.repository_index_digest(request.project_id, request.source_commit) if from_run else None
                if indexed is None or request.evidence_digest not in (None, indexed):
                    raise DomainError("MEMORY_PROVENANCE", "Provenance does not match a project delivery")
                request = request.model_copy(update={"evidence_digest": indexed})
        item = MemoryItem(**request.model_dump(), id=digest(memory_identity(request)), active=verifiable,
                          approved_at=now() if verifiable else None, proposed_by=proposed_by)
        # Factory consolidation and repository reads stay free of model calls, so their proposals are recalled lexically.
        mechanical = proposed_by is not None and proposed_by.channel in {"factory", "repository"}
        embedding = await self.embeddings.aembed_query(item.content) if self.embeddings and not verifiable and not mechanical else None
        return await self.repository.create_memory(item, embedding)

    def proposer(self, work: WorkOrder, role: str, commit: str):
        """The propose_memory tool of one specialist assignment. A refusal is a result, never a failed stage."""
        used = 0

        def refused(code: str, reason: str) -> dict:
            return {"proposed": False, "code": code, "reason": reason}

        async def propose_memory(statement: str, why: str, citations: list[str], kind: str = "fact"):
            nonlocal used
            if used >= MAX_STEP_PROPOSALS:
                return refused("MEMORY_PROPOSAL_LIMIT", f"This assignment already proposed {MAX_STEP_PROPOSALS} memories. Continue with the task.")
            if await self.repository.run_proposal_count(work.id) >= MAX_RUN_PROPOSALS:
                return refused("MEMORY_PROPOSAL_LIMIT", f"This run already proposed {MAX_RUN_PROPOSALS} memories. Continue with the task.")
            try:
                # One line of statement, so the record has a title; the reason follows on its own line.
                request = MemoryCreate(project_id=work.project_id, kind=kind, source_commit=commit, source_work_id=work.id,
                                       content=f"{' '.join(statement.split())}\nWhy it matters: {' '.join(why.split())}",
                                       scope="project", citations=citations)
                item = await self.propose(request, proposed_by=ProposedBy(channel="factory", role=role, work_id=work.id))
            except ValidationError:
                return refused("INVALID_CITATION", "Write each citation as a repository-relative path, optionally followed by #L<line>.")
            except DomainError as error:
                if error.code not in PROPOSAL_REFUSALS:
                    raise
                return refused(error.code, PROPOSAL_REFUSALS[error.code])
            used += 1
            return {"proposed": True, "memory_id": item.id, "state": "waiting for the owner's review",
                    "remaining_in_assignment": MAX_STEP_PROPOSALS - used}
        return propose_memory

    async def withdraw(self, memory_id: str) -> bool:
        """Withdraw a proposal nobody decided on; approved and already invalidated memories are left alone."""
        return await self.repository.withdraw_memory(memory_id)

    async def update(self, memory_id: str, approve: bool, decision: MemoryApproval | None = None):
        if decision is None or not approve:
            return await self.repository.set_memory_state(memory_id, approve)
        return await self.repository.set_memory_state(memory_id, approve, scope=decision.scope, supersedes=decision.supersedes,
                                                      related=decision.related)

    async def recalls(self, project_id: str, *, work_id: str | None = None, memory_id: str | None = None,
                      cursor: str | None = None, limit: int = 50) -> MemoryRecallPage:
        if cursor is not None and not re.fullmatch(r"[1-9][0-9]{0,18}", cursor):
            raise DomainError("INVALID_CURSOR", "Use the next_cursor of a previous page", 422)
        await self.repository.project(project_id)
        rows, following = await self.repository.memory_recalls(project_id, work_id=work_id, memory_id=memory_id,
                                                               cursor=int(cursor) if cursor else None, limit=limit)
        items = [MemoryRecall(id=row["id"], project_id=row["project_id"], work_id=row["work_id"], role=row["role"], stage=row["stage"],
                              commit=row["commit"], outcome=row["outcome"], error_code=row["error_code"], created_at=row["created_at"],
                              **row["data"]) for row in rows]
        return MemoryRecallPage(items=items, next_cursor=str(following) if following is not None else None)

    async def graph(self, project_id: str, focus: str | None = None, depth: int = 1, limit: int = 100) -> MemoryGraph:
        await self.repository.project(project_id)
        return MemoryGraph.model_validate(await self.repository.memory_graph(project_id, focus, depth, limit))

    async def _list_items(self, rows: list[dict], commit: str | None) -> list[MemoryListItem]:
        stats = await self.repository.memory_recall_stats([row["id"] for row in rows]) if rows else {}
        result = []
        for row in rows:
            item = MemoryItem.model_validate(row["data"])
            recall = stats.get(item.id) or {}
            result.append(MemoryListItem(**item.model_dump(), state=lifecycle(item), validity=validity_at(item, commit, row["validity"]),
                                         recall_count=int(recall.get("recall_count") or 0), last_recalled_at=recall.get("last_recalled_at"),
                                         link_counts=MemoryLinkCounts(**dict(row["link_counts"] or {}))))
        return result

    async def items(self, project_id: str, *, state: str | None = None, kind: str | None = None, query: str | None = None,
                    cursor: str | None = None, limit: int = 50) -> MemoryItemPage:
        after = decode_cursor(cursor)
        await self.repository.project(project_id)
        commit = await self.repository.newest_indexed_commit(project_id)
        rows = await self.repository.memory_page(project_id, commit=commit, state=state, kind=kind, query=query or None, after=after, limit=limit + 1)
        items = await self._list_items(rows[:limit], commit)
        self.guard.check([item.model_dump(mode="json") for item in items])
        return MemoryItemPage(commit=commit, items=items, next_cursor=encode_cursor(items[-1]) if len(rows) > limit else None)

    async def detail(self, memory_id: str) -> MemoryDetail:
        item = await self.repository.memory(memory_id)
        commit = await self.repository.newest_indexed_commit(item.project_id)
        listed = (await self._list_items(await self.repository.memory_page(item.project_id, commit=commit, memory_id=memory_id, limit=1), commit))[0]
        outgoing, incoming = await self.repository.memory_links_of(memory_id)
        work = await self.repository.memory_work_summary(item.project_id, item.source_work_id) if item.source_work_id else None
        stats = (await self.repository.memory_recall_stats([memory_id])).get(memory_id) or {}
        detail = MemoryDetail(
            item=listed,
            provenance=MemoryProvenance(work_id=item.source_work_id, work_objective=work["objective"] if work else None,
                                        work_status=work["status"] if work else None, commit=item.source_commit,
                                        evidence_digest=item.evidence_digest, proposed_by=item.proposed_by,
                                        approved_at=item.approved_at, invalidated_at=item.invalidated_at),
            links=[MemoryLink.model_validate(row) for row in outgoing],
            backlinks=[MemoryLink.model_validate(row) for row in incoming],
            validity_history=[MemoryValidityRecord.model_validate(row) for row in await self.repository.memory_validity_history(memory_id)],
            recalls=MemoryRecallStats(recall_count=int(stats.get("recall_count") or 0), last_recalled_at=stats.get("last_recalled_at"),
                                      refused_count=int(stats.get("refused_count") or 0)))
        self.guard.check(detail.model_dump(mode="json"))
        return detail

    async def review(self, project_id: str) -> MemoryReview:
        await self.repository.project(project_id)
        commit = await self.repository.newest_indexed_commit(project_id)
        pending_rows = await self.repository.memory_page(project_id, commit=commit, state="pending", limit=REVIEW_LIMIT + 1)
        stale_rows = await self.repository.memory_page(project_id, commit=commit, state="stale", limit=REVIEW_LIMIT + 1) if commit else []
        pending = await self._list_items(pending_rows[:REVIEW_LIMIT], commit)
        stale = await self._list_items(stale_rows[:REVIEW_LIMIT], commit)
        overlaps: dict[str, list[OverlapEntry]] = {item.id: [] for item in pending}
        links = await self.repository.memory_overlaps(project_id, list(overlaps)) if overlaps else []
        for row in links:
            attrs = dict(row["attrs"])
            for this, other, own, theirs in ((row["source_id"], row["target"], "only_source", "only_target"),
                                             (row["target_id"], row["source"], "only_target", "only_source")):
                if this not in overlaps:
                    continue
                other_item = MemoryItem.model_validate(other)
                overlaps[this].append(OverlapEntry(memory_id=other_item.id, state=lifecycle(other_item), content=other_item.content[:240],
                                                   score=attrs["score"], lexical=attrs["lexical"], cosine=attrs.get("cosine"),
                                                   only_this=attrs.get(own, []), only_other=attrs.get(theirs, [])))
        review = MemoryReview(
            commit=commit,
            pending=[PendingReview(item=item, overlaps=sorted(overlaps[item.id], key=lambda entry: (-entry.score, entry.memory_id))) for item in pending],
            stale=[StaleReview(item=item, changed_paths=item.validity.changed_paths) for item in stale],
            truncated=len(pending_rows) > REVIEW_LIMIT or len(stale_rows) > REVIEW_LIMIT)
        self.guard.check(review.model_dump(mode="json"))
        return review

    async def carry_forward(self, memory_id: str, request: MemoryCarryForward):
        return MemoryValidityRecord.model_validate(await self.repository.carry_memory_forward(memory_id, request.commit))

    async def search(self, project_id: str, query: str, commit: str, *, work: WorkOrder | None = None):
        self.guard.check(query)
        embedding = await self._embedding(project_id, query, commit, work)
        items = await self.repository.search_memory(project_id, query, commit, embedding)
        # Returned memories remain untrusted context, never instructions or permissions.
        self.guard.check([item.model_dump(mode="json") for item in items])
        return [{"content": i.content, "source_commit": i.source_commit, "source_work_id": i.source_work_id} for i in items]

    async def _embedding(self, project_id, query, commit, work):
        if self.embeddings and await self.repository.has_embedded_memory(project_id, commit):
            return await self.embeddings.aembed_query(query, work=work)
        return None

    async def _indexed(self, project_id: str, commit: str) -> bool:
        checker = getattr(self.repository, "has_repository_index", None)
        return await checker(project_id, commit) if checker is not None else True

    async def _record_recall(self, recall: dict):
        recorder = getattr(self.repository, "record_memory_recall", None)
        if recorder is not None and recall["work_id"] is not None:
            await recorder(recall)

    async def context_for_role(self, project_id: str, objective: str, instruction: str, commit: str, *, work: WorkOrder, role: str | None = None):
        self.guard.check([objective, instruction])
        query = bounded_text(instruction, 512) + "\n" + bounded_text(objective, 512)
        embedding = await self._embedding(project_id, query, commit, work)
        # OR terms recover task-relevant notes without requiring every word of an instruction.
        terms = list(dict.fromkeys(re.findall(r"[\w.-]{3,64}", bounded_text(instruction, 512))[:16]
                                   + re.findall(r"[\w.-]{3,64}", bounded_text(objective, 512))[:16]))
        lexical_query = " OR ".join(f'"{term}"' for term in terms)
        items = await self.repository.search_memory(project_id, lexical_query, commit, embedding, match_any=True)
        self.guard.check([item.model_dump(mode="json") for item in items])
        selected = items[:MAX_CONTEXT_ITEMS]
        result = []
        for item in selected:
            value = memory_excerpt(item, query, (MAX_CONTEXT_BYTES - 8) // MAX_CONTEXT_ITEMS - 160)
            value.update(omitted_memories=len(items) - len(selected), selection_truncated=len(items) > len(selected),
                         retrieved_candidates=len(items), retrieval_limit_reached=len(items) == 8)
            result.append(value)
        if encoded_size(result) > MAX_CONTEXT_BYTES:
            raise DomainError("MEMORY_CONTEXT_LIMIT", "Memories exceed the context limit")
        await self._record_recall({
            "id": new_id(), "project_id": project_id, "work_id": getattr(work, "id", None), "role": role, "stage": getattr(work, "phase", None),
            "commit": commit, "outcome": "recalled", "error_code": None, "memory_ids": [item.id for item in selected],
            "data": {"query_terms": terms[:MAX_RECALL_TERMS], "candidates": len(items), "omitted": len(items) - len(selected),
                     "bytes": encoded_size(result), "refused_memory_ids": [],
                     # Without an index at this commit nothing recorded at another commit can be evaluated.
                     "index_missing": not await self._indexed(project_id, commit),
                     "selected": [{"memory_id": item.id, "lexical_rank": getattr(item, "lexical_rank", None),
                                   "vector_rank": getattr(item, "vector_rank", None), "fused_score": getattr(item, "fused_score", None),
                                   "bytes": encoded_size(value), "truncated": value["truncated"]} for item, value in zip(selected, result, strict=True)]},
        })
        return result

    def reader(self, project_id: str, commit: str):
        async def read_memory(memory_id: str, content_digest: str, offset: int = 0, limit: int = MAX_READ_CHARS):
            if not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", memory_id) or not re.fullmatch(r"[a-f0-9]{64}", content_digest) or type(offset) is not int or not 0 <= offset <= 8000 or type(limit) is not int or not 1 <= limit <= MAX_READ_CHARS:
                raise DomainError("INVALID_TOOL_ARGUMENTS", "The memory read exceeds limits", 422)
            item = await self.repository.memory_for_context(project_id, commit, memory_id)
            self.guard.check(item.model_dump(mode="json"))
            reference = memory_reference(item)
            if reference["content_digest"] != content_digest:
                raise DomainError("MEMORY_CONTEXT_STALE", "The memory no longer matches the requested content", 409)
            if offset > len(item.content):
                raise DomainError("INVALID_TOOL_ARGUMENTS", "The position does not belong to the memory", 422)
            result = {**reference, "project_id": project_id, "content": item.content[offset:offset + limit], "offset": offset,
                      "truncated": False, "next_offset": None}
            while True:
                end = offset + len(result["content"])
                result.update(truncated=offset > 0 or end < len(item.content), next_offset=end if end < len(item.content) else None)
                if encoded_size(result) <= MAX_CONTEXT_BYTES:
                    return result
                if not result["content"]:
                    raise DomainError("MEMORY_CONTEXT_LIMIT", "Memory provenance exceeds the context limit")
                result["content"] = result["content"][:len(result["content"]) // 2]
        return read_memory

    def context_validator(self, project_id: str, commit: str, *, work: WorkOrder | None = None, role: str | None = None):
        async def validate(references: list[dict]):
            try:
                await check(references)
            except DomainError as error:
                # A refusal is part of the recall log: which saved memories could not be revalidated and why.
                identifiers = [reference["id"] for reference in references if isinstance(reference, dict) and isinstance(reference.get("id"), str)
                               and re.fullmatch(r"[A-Za-z0-9_-]{1,128}", reference["id"])] if isinstance(references, list) else []
                identifiers = list(dict.fromkeys(identifiers))[:MAX_CONTEXT_ITEMS * 8]
                await self._record_recall({
                    "id": new_id(), "project_id": project_id, "work_id": getattr(work, "id", None), "role": role, "stage": getattr(work, "phase", None),
                    "commit": commit, "outcome": "refused", "error_code": error.code, "memory_ids": identifiers,
                    "data": {"query_terms": [], "candidates": 0, "omitted": 0, "bytes": 0, "selected": [], "refused_memory_ids": identifiers}})
                raise

        async def check(references: list[dict]):
            def changed():
                return DomainError("MEMORY_CONTEXT_CHANGED", "Saved memory is no longer verifiable; explicitly replan context before continuing", 409)
            if not isinstance(references, list):
                raise changed()
            checked = set()
            for reference in references:
                if not isinstance(reference, dict):
                    raise changed()
                identifier, signature = reference.get("id"), reference.get("content_digest")
                if not isinstance(identifier, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", identifier) or not isinstance(signature, str) or not re.fullmatch(r"[a-f0-9]{64}", signature):
                    raise changed()
                if reference.get("project_id", project_id) != project_id:
                    raise changed()
                key = (identifier, signature)
                if key in checked:
                    continue
                try:
                    item = await self.repository.memory_for_context(project_id, commit, identifier)
                except DomainError as error:
                    if error.code == "MEMORY_NOT_AVAILABLE":
                        raise changed() from None
                    raise
                self.guard.check(item.model_dump(mode="json"))
                # The repository admits the memory only while it is valid at this commit; the reference
                # must still name the same source commit, and a commit-scoped memory only its own commit.
                if (item.project_id != project_id or reference.get("source_commit", item.source_commit) != item.source_commit
                        or (item.scope != "project" and item.source_commit != commit) or not item.active
                        or item.invalidated_at is not None or hashlib.sha256(item.content.encode()).hexdigest() != signature):
                    raise changed()
                checked.add(key)
        return validate
