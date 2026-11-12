"""PostgreSQL memory store: lifecycle, commit validity and relational links. No graph database.

A ``commit``-scoped memory is recallable only at its source commit. A ``project``-scoped approved memory
is also recallable at another commit C once C has a repository index and every file it cites still has
the content digest recorded at its last valid commit. Evaluations are stored in ``memory_validity`` so
the decision and its basis remain inspectable; invalidation stays final.
"""

import json
from typing import Any

from psycopg import sql
from psycopg.types.json import Jsonb

from sabre.models import DomainError, MemoryItem, citation_parts, now

MEMORY_GRAPH_SCHEMA = """
CREATE TABLE memory_links(
 id bigserial PRIMARY KEY,
 project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
 source_id text NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
 kind text NOT NULL CHECK(kind IN ('cites','supersedes','related','overlaps')),
 target_type text NOT NULL CHECK(target_type IN ('file','memory')),
 target_id text NOT NULL,
 attrs jsonb NOT NULL DEFAULT '{}',
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(source_id,kind,target_type,target_id));
CREATE INDEX memory_links_target ON memory_links(project_id,target_type,target_id);
CREATE TABLE memory_validity(
 id bigserial PRIMARY KEY,
 project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
 memory_id text NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
 commit text NOT NULL,
 state text NOT NULL CHECK(state IN ('valid','stale')),
 basis text NOT NULL CHECK(basis IN ('no_citations','citations_unchanged','citations_changed','owner')),
 changed_paths jsonb NOT NULL DEFAULT '[]',
 digests jsonb NOT NULL DEFAULT '{}',
 checked_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK((basis='owner')<=(state='valid')));
CREATE UNIQUE INDEX memory_validity_once ON memory_validity(memory_id,commit,(basis='owner'));
CREATE INDEX memory_validity_commit ON memory_validity(project_id,commit);
"""

MAX_VALIDITY_BATCH = 500

# Approved, not invalidated and either recorded at this commit or a project memory valid here.
# An owner carry-forward row is always valid, so any valid row decides; stale rows never do.
RECALLABLE = """m.project_id=%(project)s AND (m.data->>'active')::boolean AND m.data->>'invalidated_at' IS NULL
 AND (m.data->>'source_commit'=%(commit)s OR (coalesce(m.data->>'scope','commit')='project' AND EXISTS(
  SELECT 1 FROM memory_validity v WHERE v.memory_id=m.id AND v.commit=%(commit)s AND v.state='valid')))"""


def index_version() -> int:
    from sabre.project_context import INDEX_VERSION
    return INDEX_VERSION


def item_from(data) -> MemoryItem:
    return MemoryItem.model_validate(data)


def cited_paths(citations: list[str]) -> dict[str, list[int]]:
    paths: dict[str, list[int]] = {}
    for citation in citations:
        path, line = citation_parts(citation)
        lines = paths.setdefault(path, [])
        if line is not None and line not in lines:
            lines.append(line)
    return paths


def evaluate(baseline: dict[str, str], files: dict[str, str]) -> dict[str, Any]:
    """Compare a memory's cited digests with an index; renamed files count as deleted at the old path."""
    if not baseline:
        return {"state": "valid", "basis": "no_citations", "changed_paths": [], "digests": {}}
    changed = []
    for path in sorted(baseline):
        current = files.get(path)
        if current is None:
            changed.append({"path": path, "change": "deleted"})
        elif current != baseline[path]:
            changed.append({"path": path, "change": "changed"})
    if changed:
        return {"state": "stale", "basis": "citations_changed", "changed_paths": changed,
                "digests": {path: files.get(path) for path in sorted(baseline)}}
    return {"state": "valid", "basis": "citations_unchanged", "changed_paths": [], "digests": dict(sorted(baseline.items()))}


class MemoryStore:
    """Mixin for ``Repository``; every query is bounded and scoped by project."""

    def connection(self) -> Any:  # pragma: no cover - provided by Repository
        raise NotImplementedError

    async def _index_digests(self, conn, project_id: str, commit: str, paths: list[str]) -> dict[str, str] | None:
        """Digests of ``paths`` in the repository index at ``commit``; None when that commit has no index."""
        row = await (await conn.execute("""SELECT (SELECT coalesce(jsonb_object_agg(f->>'path',f->>'content_digest'),'{}'::jsonb)
                FROM jsonb_array_elements(i.data->'files') f WHERE f->>'path'=ANY(%s)) AS files
            FROM repository_indexes i WHERE i.project_id=%s AND i.source_commit=%s AND i.index_version=%s""",
            (paths, project_id, commit, index_version()))).fetchone()
        return None if row is None else dict(row["files"])

    async def has_repository_index(self, project_id: str, commit: str) -> bool:
        async with self.connection() as conn:
            return await self._index_digests(conn, project_id, commit, []) is not None

    async def _insert_citations(self, conn, item: MemoryItem):
        if not item.citations:
            return
        paths = cited_paths(item.citations)
        digests = await self._index_digests(conn, item.project_id, item.source_commit, sorted(paths))
        if digests is None:
            raise DomainError("MEMORY_INDEX_MISSING", "Index the source commit before citing files in a memory", 409)
        unknown = sorted(set(paths) - set(digests))
        if unknown:
            raise DomainError("MEMORY_CITATION_UNKNOWN", "Cited files must exist in the repository index at the source commit: " + ", ".join(unknown)[:500], 422)
        for path, lines in paths.items():
            await conn.execute("""INSERT INTO memory_links(project_id,source_id,kind,target_type,target_id,attrs)
                VALUES(%s,%s,'cites','file',%s,%s) ON CONFLICT DO NOTHING""",
                (item.project_id, item.id, path, Jsonb({"digest": digests[path], "lines": sorted(lines), "commit": item.source_commit})))

    async def create_memory(self, item: MemoryItem, embedding: list[float] | None = None):
        async with self.connection() as conn:
            created = await (await conn.execute("INSERT INTO memories(id,project_id,data,embedding) VALUES(%s,%s,%s,%s) ON CONFLICT(id) DO NOTHING RETURNING id",
                (item.id, item.project_id, Jsonb(json.loads(item.model_dump_json())), str(embedding) if embedding else None))).fetchone()
            if created:
                await self._insert_citations(conn, item)
            row = await (await conn.execute("SELECT data FROM memories WHERE id=%s", (item.id,))).fetchone()
            return item_from(row["data"])

    async def set_memory_state(self, memory_id: str, approve: bool, *, scope: str | None = None):
        async with self.connection() as conn:
            row = await (await conn.execute("SELECT data FROM memories WHERE id=%s FOR UPDATE", (memory_id,))).fetchone()
            if not row:
                raise DomainError("MEMORY_NOT_FOUND", "Memory not found", 404)
            item = item_from(row["data"])
            if item.invalidated_at:
                raise DomainError("MEMORY_INVALIDATED", "The memory is invalidated; create a new proposal")
            if approve:
                item.active, item.approved_at = True, now()
                if scope is not None:
                    item.scope = scope  # type: ignore[assignment]
            else:
                item.active, item.invalidated_at = False, now()
            await conn.execute("UPDATE memories SET data=%s WHERE id=%s", (Jsonb(json.loads(item.model_dump_json())), memory_id))
        return item

    async def memories(self, project_id: str) -> list[MemoryItem]:
        async with self.connection() as conn:
            cursor = await conn.execute("SELECT data FROM memories WHERE project_id=%s ORDER BY data->>'created_at' DESC", (project_id,))
            return [item_from(r["data"]) async for r in cursor]

    async def memory(self, memory_id: str) -> MemoryItem:
        async with self.connection() as conn:
            row = await (await conn.execute("SELECT data FROM memories WHERE id=%s", (memory_id,))).fetchone()
        if not row:
            raise DomainError("MEMORY_NOT_FOUND", "Memory not found", 404)
        return item_from(row["data"])

    async def _ensure_validity(self, conn, project_id: str, commit: str) -> bool:
        """Record validity at ``commit`` for approved project memories not yet evaluated there.

        Returns False when the commit has no repository index (``INDEX_MISSING``): nothing is guessed
        or stored, and such memories are not recallable at that commit.
        """
        rows = await (await conn.execute("""SELECT m.id,
                (SELECT v.digests FROM memory_validity v WHERE v.memory_id=m.id AND v.state='valid' ORDER BY v.id DESC LIMIT 1) AS carried,
                (SELECT coalesce(jsonb_object_agg(l.target_id,l.attrs->>'digest'),'{}'::jsonb) FROM memory_links l
                    WHERE l.source_id=m.id AND l.kind='cites' AND l.target_type='file') AS cited
            FROM memories m WHERE m.project_id=%(project)s AND (m.data->>'active')::boolean AND m.data->>'invalidated_at' IS NULL
                AND coalesce(m.data->>'scope','commit')='project' AND m.data->>'source_commit'<>%(commit)s
                AND NOT EXISTS(SELECT 1 FROM memory_validity v WHERE v.memory_id=m.id AND v.commit=%(commit)s)
            ORDER BY m.id LIMIT %(limit)s""", {"project": project_id, "commit": commit, "limit": MAX_VALIDITY_BATCH})).fetchall()
        if not rows:
            return True
        # The latest valid evaluation is the baseline: the source citations until an owner carries it forward.
        baselines = {row["id"]: dict(row["carried"] if row["carried"] is not None else row["cited"]) for row in rows}
        files = await self._index_digests(conn, project_id, commit, sorted({path for value in baselines.values() for path in value}))
        if files is None:
            return False
        for memory_id, baseline in baselines.items():
            result = evaluate(baseline, files)
            await conn.execute("""INSERT INTO memory_validity(project_id,memory_id,commit,state,basis,changed_paths,digests)
                VALUES(%s,%s,%s,%s,%s,%s,%s) ON CONFLICT DO NOTHING""",
                (project_id, memory_id, commit, result["state"], result["basis"], Jsonb(result["changed_paths"]), Jsonb(result["digests"])))
        return True

    async def ensure_memory_validity(self, project_id: str, commit: str) -> bool:
        async with self.connection() as conn:
            return await self._ensure_validity(conn, project_id, commit)

    async def memory_validity_history(self, memory_id: str, limit: int = 50) -> list[dict]:
        async with self.connection() as conn:
            return await (await conn.execute("""SELECT commit,state,basis,changed_paths,checked_at FROM memory_validity
                WHERE memory_id=%s ORDER BY id DESC LIMIT %s""", (memory_id, limit))).fetchall()

    async def carry_memory_forward(self, memory_id: str, commit: str) -> dict:
        """The owner's judgement that a stale project memory still holds at ``commit``."""
        async with self.connection() as conn:
            row = await (await conn.execute("SELECT project_id,data FROM memories WHERE id=%s FOR UPDATE", (memory_id,))).fetchone()
            if not row:
                raise DomainError("MEMORY_NOT_FOUND", "Memory not found", 404)
            item = item_from(row["data"])
            if item.invalidated_at is not None:
                raise DomainError("MEMORY_INVALIDATED", "The memory is invalidated; create a new proposal")
            if not item.active or item.scope != "project":
                raise DomainError("MEMORY_NOT_CARRYABLE", "Only approved project-scoped memories can be carried to another commit", 409)
            if commit == item.source_commit:
                return {"commit": commit, "state": "valid", "basis": "source_commit", "changed_paths": [], "checked_at": item.approved_at or item.created_at}
            if not await self._ensure_validity(conn, item.project_id, commit):
                raise DomainError("MEMORY_INDEX_MISSING", "Index this commit before carrying a memory to it", 409)
            current = await (await conn.execute("""SELECT commit,state,basis,changed_paths,digests,checked_at FROM memory_validity
                WHERE memory_id=%s AND commit=%s ORDER BY (state='valid') DESC,id DESC LIMIT 1""", (memory_id, commit))).fetchone()
            if current is None:
                raise DomainError("MEMORY_VALIDITY_PENDING", "The memory has not been evaluated at this commit yet; retry", 409)
            if current["state"] == "valid":
                return {key: current[key] for key in ("commit", "state", "basis", "changed_paths", "checked_at")}
            # Deleted citations leave the baseline; changed ones adopt the digest the owner reviewed.
            digests = {path: value for path, value in dict(current["digests"]).items() if value is not None}
            created = await (await conn.execute("""INSERT INTO memory_validity(project_id,memory_id,commit,state,basis,changed_paths,digests)
                VALUES(%s,%s,%s,'valid','owner',%s,%s) ON CONFLICT DO NOTHING RETURNING commit,state,basis,changed_paths,checked_at""",
                (item.project_id, memory_id, commit, Jsonb(current["changed_paths"]), Jsonb(digests)))).fetchone()
            if created is None:
                created = await (await conn.execute("""SELECT commit,state,basis,changed_paths,checked_at FROM memory_validity
                    WHERE memory_id=%s AND commit=%s AND basis='owner'""", (memory_id, commit))).fetchone()
            return dict(created)

    async def has_embedded_memory(self, project_id: str, commit: str) -> bool:
        async with self.connection() as conn:
            await self._ensure_validity(conn, project_id, commit)
            row = await (await conn.execute(f"SELECT EXISTS(SELECT 1 FROM memories m WHERE {RECALLABLE} AND m.embedding IS NOT NULL) AS found",  # noqa: S608 - constant fragment
                {"project": project_id, "commit": commit})).fetchone()
        return row["found"]

    async def memory_for_context(self, project_id: str, commit: str, memory_id: str) -> MemoryItem:
        async with self.connection() as conn:
            await self._ensure_validity(conn, project_id, commit)
            row = await (await conn.execute(f"SELECT m.data FROM memories m WHERE m.id=%(id)s AND {RECALLABLE}",  # noqa: S608 - constant fragment
                {"id": memory_id, "project": project_id, "commit": commit})).fetchone()
        if row is None:
            raise DomainError("MEMORY_NOT_AVAILABLE", "The memory is not active and valid for this project and commit", 404)
        return item_from(row["data"])

    async def search_memory(self, project_id: str, query: str, commit: str, embedding: list[float] | None = None, *, match_any=False):
        query_function = sql.Identifier("websearch_to_tsquery" if match_any else "plainto_tsquery")
        values = {"project": project_id, "commit": commit, "query": query, "vector": str(embedding) if embedding else None}
        async with self.connection() as conn:
            await self._ensure_validity(conn, project_id, commit)
            if embedding:
                statement = sql.SQL("""
                    WITH scoped AS (
                        SELECT m.id,m.data,m.document,m.embedding FROM memories m WHERE {recallable}
                    ), semantic AS (
                        SELECT id,row_number() OVER (ORDER BY embedding <=> %(vector)s::vector,id) AS position
                        FROM scoped WHERE embedding IS NOT NULL ORDER BY position LIMIT 8
                    ), lexical AS (
                        SELECT id,row_number() OVER (ORDER BY ts_rank(document,{query_function}('simple',%(query)s)) DESC,id) AS position
                        FROM scoped WHERE document @@ {query_function}('simple',%(query)s) ORDER BY position LIMIT 8
                    ), scores AS (
                        SELECT id,sum(1.0/(60+position)) AS score FROM (
                            SELECT id,position FROM semantic UNION ALL SELECT id,position FROM lexical
                        ) candidates GROUP BY id
                    )
                    SELECT scoped.data FROM scores JOIN scoped USING(id) ORDER BY scores.score DESC,id LIMIT 8
                """).format(recallable=sql.SQL(RECALLABLE), query_function=query_function)
            else:
                statement = sql.SQL("""SELECT m.data FROM memories m WHERE {recallable}
                    AND m.document @@ {query_function}('simple',%(query)s)
                    ORDER BY ts_rank(m.document,{query_function}('simple',%(query)s)) DESC,m.id LIMIT 8""").format(
                    recallable=sql.SQL(RECALLABLE), query_function=query_function)
            cursor = await conn.execute(statement, values)
            return [item_from(r["data"]) async for r in cursor]
