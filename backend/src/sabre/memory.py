import hashlib
import json
import re

from sabre.models import DomainError, MemoryCreate, MemoryItem, WorkOrder, now
from sabre.repository import digest

MAX_CONTEXT_BYTES = 6144
MAX_CONTEXT_ITEMS = 4
MAX_READ_CHARS = 2048


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
    return f"Commit {work.evidence.commit}: {len(work.evidence.gates)} comprobaciones aprobadas; snapshot {work.evidence.snapshot_digest}."


class MemoryService:
    def __init__(self, repository, guard, embeddings=None):
        self.repository = repository
        self.guard = guard
        self.embeddings = embeddings

    async def propose(self, request: MemoryCreate) -> MemoryItem:
        self.guard.check(request.model_dump())
        work = await self.repository.work(request.source_work_id)
        if work.project_id != request.project_id or not work.evidence or work.evidence.commit != request.source_commit:
            raise DomainError("MEMORY_PROVENANCE", "Provenance does not match a project delivery")
        # Recovery may queue a published order before replaying its final memory write.
        delivered = work.status == "completed" or bool(work.evidence.branch and work.evidence.pr_url)
        verifiable = request.kind == "fact" and delivered and request.content == verified_fact(work) and request.evidence_digest == work.evidence.snapshot_digest
        item = MemoryItem(**request.model_dump(), id=digest(request.model_dump()), active=verifiable, approved_at=now() if verifiable else None)
        embedding = await self.embeddings.aembed_query(item.content) if self.embeddings and not verifiable else None
        return await self.repository.create_memory(item, embedding)

    async def update(self, memory_id: str, approve: bool):
        return await self.repository.set_memory_state(memory_id, approve)

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

    async def context_for_role(self, project_id: str, objective: str, instruction: str, commit: str, *, work: WorkOrder):
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

    def context_validator(self, project_id: str, commit: str):
        async def validate(references: list[dict]):
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
                if reference.get("project_id", project_id) != project_id or reference.get("source_commit", commit) != commit:
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
                if item.project_id != project_id or item.source_commit != commit or not item.active or item.invalidated_at is not None or hashlib.sha256(item.content.encode()).hexdigest() != signature:
                    raise changed()
                checked.add(key)
        return validate
