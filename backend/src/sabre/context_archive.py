"""Read-only recovery of exact historical tool responses in one authorized child."""

import hashlib
from dataclasses import dataclass

from sabre.agent_context import successful_reads
from sabre.models import DomainError


@dataclass(frozen=True)
class ArchivedRead:
    response_digest: str
    original_bytes: int


# One recovery page. Larger pages mean fewer read_context round trips for the same text.
READ_CONTEXT_PAGE = 8192

class ContextArchive:
    def __init__(self, artifacts, guard):
        self.artifacts, self.guard = artifacts, guard
        self._allowed: dict[str, ArchivedRead] = {}
        self._restored_pages = 0
        self._unknown_interval = False

    def bind(self, messages, *, restored=False):
        # Authority comes from original LangGraph messages, never a reference's text.
        self.guard.check([message.model_dump(mode="json") for message in messages])
        self._allowed = {message.tool_call_id: ArchivedRead(hashlib.sha256(message.content.encode()).hexdigest(), len(message.content.encode()))
            for _, message, _ in successful_reads(messages)}
        self._unknown_interval = self._unknown_interval or restored

    @property
    def restored_pages(self):
        return None if self._unknown_interval else self._restored_pages

    def acknowledge(self):
        self._restored_pages = 0
        self._unknown_interval = False

    async def read(self, tool_call_id: str, response_digest: str, offset: int = 0, limit: int = READ_CONTEXT_PAGE):
        allowed = self._allowed.get(tool_call_id)
        if allowed is None or allowed.response_digest != response_digest:
            raise DomainError("CONTEXT_REFERENCE_NOT_ALLOWED", "The reference does not belong to a read by this agent", 403)
        if type(offset) is not int or type(limit) is not int or offset < 0 or not 1 <= limit <= READ_CONTEXT_PAGE:
            raise DomainError("INVALID_CONTEXT_RANGE", f"Use a nonnegative offset and between 1 and {READ_CONTEXT_PAGE} characters", 422)
        raw = self.artifacts.get(response_digest)
        if len(raw) != allowed.original_bytes or hashlib.sha256(raw).hexdigest() != response_digest:
            raise DomainError("ARTIFACT_CORRUPT", "The historical read size does not match")
        try:
            original = raw.decode("utf-8")
        except UnicodeDecodeError:
            raise DomainError("ARTIFACT_CORRUPT", "The historical read does not contain valid text") from None
        # Check the complete value with today's secrets, including across page boundaries.
        self.guard.check(original)
        if offset > len(original):
            raise DomainError("INVALID_CONTEXT_RANGE", "The offset exceeds the historical read", 422)
        end = min(len(original), offset + limit)
        result = {"historical": True, "currentness": "not_revalidated", "tool_call_id": tool_call_id,
            "response_digest": response_digest, "original_bytes": len(raw), "offset": offset,
            "next_offset": end if end < len(original) else None, "eof": end == len(original), "content": original[offset:end]}
        self.guard.check(result)
        self._restored_pages += 1
        return result
