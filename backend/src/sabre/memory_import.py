"""Turns what a repository says (``memory_sources``) into memory proposals when a commit is indexed.

Reading is deterministic and repeatable: the same commit proposes the same records, and nothing is
activated here. Each statement is compared with the newest record of the same title:

- same text, approved or still waiting: nothing to do;
- same text, rejected or revoked by the owner: not proposed again;
- different text, still waiting: the old proposal is withdrawn and the new text proposed;
- different text, approved: the new text is proposed as a replacement that supersedes it on approval.

A waiting proposal follows its file, so it always cites the newest commit read; one whose statement is
gone from the repository is withdrawn. An approved record whose file changed is left to commit
validity, which lists it for revalidation.
"""

import hashlib

from pydantic import Field

from sabre.contracts import StrictContract
from sabre.memory_sources import repository_statements, title_of
from sabre.memory_store import lifecycle
from sabre.models import DomainError, MemoryCreate, MemoryItem, ProposedBy


class ImportSummary(StrictContract):
    """What one read of the repository did to the project's memory."""

    proposed: int = Field(default=0, description="Statements new to memory, now waiting for review")
    replaced: int = Field(default=0, description="Statements whose text changed: proposed in place of a waiting or approved record")
    unchanged: int = Field(default=0, description="Statements already waiting or approved with this text")
    declined: int = Field(default=0, description="Statements the owner rejected or revoked with this same text; not proposed again")
    withdrawn: int = Field(default=0, description="Waiting proposals withdrawn because the repository no longer says them")
    refused: int = Field(default=0, description="Statements the memory service refused, for example for a detected secret")
    omitted: int = Field(default=0, description="Statements beyond the bound of one read")


class RepositoryMemoryImport:
    def __init__(self, repository, memory):
        self.repository, self.memory = repository, memory

    async def run(self, project_id: str, commit: str, files: dict[str, str]) -> ImportSummary:
        statements, omitted = repository_statements(files)
        summary = ImportSummary(omitted=omitted)
        newest: dict[str, dict] = {}
        for record in await self.repository.repository_memories(project_id):
            newest.setdefault(title_of(record["item"].content), record)
        for statement in statements:
            record = newest.pop(statement.title, None)
            outcome, supersedes = "proposed", None
            if record is not None:
                previous: MemoryItem = record["item"]
                state = lifecycle(previous)
                same_text = previous.content == statement.content
                if same_text and state == "invalidated" and previous.invalidated_as != "withdrawn":
                    summary.declined += 1
                    continue
                if state == "pending":
                    digest = hashlib.sha256(files[statement.path].encode()).hexdigest()
                    if same_text and (previous.source_commit == commit or record["cited_digest"] == digest):
                        summary.unchanged += 1
                        continue
                    # Withdrawn first, so the new proposal is not compared with the text it replaces.
                    await self.memory.withdraw(previous.id)
                elif state == "active":
                    if same_text:
                        summary.unchanged += 1
                        continue
                    supersedes = previous.id
                if state != "invalidated":
                    outcome = "unchanged" if same_text else "replaced"
            try:
                created = await self.memory.propose(
                    MemoryCreate(project_id=project_id, kind="fact", content=statement.content, source_commit=commit,
                                 scope="project", citations=[statement.citation], supersedes=supersedes),
                    proposed_by=ProposedBy(channel="repository", role=statement.source))
            except DomainError:
                # One refused statement must not hide the rest; the count is reported with the read.
                summary.refused += 1
                continue
            if created.invalidated_at is not None:
                # The same text at the same commit was decided before; that decision stands.
                outcome = "declined"
            setattr(summary, outcome, getattr(summary, outcome) + 1)
        for record in newest.values():
            # What is left was not said by this read of the repository.
            if lifecycle(record["item"]) == "pending" and await self.memory.withdraw(record["item"].id):
                summary.withdrawn += 1
        return summary
