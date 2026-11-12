"""PostgreSQL memory store: lifecycle, commit validity and relational links. No graph database.

A ``commit``-scoped memory is recallable only at its source commit. A ``project``-scoped approved memory
is also recallable at another commit C once C has a repository index and every file it cites still has
the content digest recorded at its last valid commit. Evaluations are stored in ``memory_validity`` so
the decision and its basis remain inspectable; invalidation stays final.
"""

import json
import re
from typing import Any, Literal

from psycopg import sql
from psycopg.types.json import Jsonb

from sabre.models import DomainError, MemoryItem, ProposedBy, citation_parts, now

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

# One row per context_for_role call (outcome recalled, possibly with nothing selected) and per refusal of
# saved memory context by the validator. memory_ids holds the selected or refused memories for lookup.
MEMORY_RECALL_SCHEMA = """
CREATE TABLE memory_recalls(
 seq bigserial PRIMARY KEY,
 id text NOT NULL UNIQUE,
 project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
 work_id text REFERENCES work_orders(id) ON DELETE CASCADE,
 role text, stage text, commit text NOT NULL,
 outcome text NOT NULL CHECK(outcome IN ('recalled','refused')),
 error_code text,
 memory_ids text[] NOT NULL DEFAULT '{}',
 data jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp());
CREATE INDEX memory_recalls_project ON memory_recalls(project_id,seq DESC);
CREATE INDEX memory_recalls_work ON memory_recalls(work_id,seq DESC);
CREATE INDEX memory_recalls_memory ON memory_recalls USING gin(memory_ids);
"""

MAX_VALIDITY_BATCH = 500

# Approved, not invalidated and either recorded at this commit or a project memory valid here.
# An owner carry-forward row is always valid, so any valid row decides; stale rows never do.
RECALLABLE = """m.project_id=%(project)s AND (m.data->>'active')::boolean AND m.data->>'invalidated_at' IS NULL
 AND (m.data->>'source_commit'=%(commit)s OR (coalesce(m.data->>'scope','commit')='project' AND EXISTS(
  SELECT 1 FROM memory_validity v WHERE v.memory_id=m.id AND v.commit=%(commit)s AND v.state='valid')))"""

# Lifecycle filters; ``stale`` means approved project memories whose evaluation at the commit is stale.
STATE_FILTERS = {
    None: "true",
    "active": "(m.data->>'active')::boolean AND m.data->>'invalidated_at' IS NULL",
    "pending": "NOT (m.data->>'active')::boolean AND m.data->>'invalidated_at' IS NULL",
    "invalidated": "m.data->>'invalidated_at' IS NOT NULL",
    "stale": """(m.data->>'active')::boolean AND m.data->>'invalidated_at' IS NULL AND coalesce(m.data->>'scope','commit')='project'
        AND m.data->>'source_commit'<>%(commit)s
        AND EXISTS(SELECT 1 FROM memory_validity v WHERE v.memory_id=m.id AND v.commit=%(commit)s AND v.state='stale')
        AND NOT EXISTS(SELECT 1 FROM memory_validity v WHERE v.memory_id=m.id AND v.commit=%(commit)s AND v.state='valid')""",
}


def index_version() -> int:
    from sabre.project_context import INDEX_VERSION
    return INDEX_VERSION


def item_from(data) -> MemoryItem:
    return MemoryItem.model_validate(data)


class RecalledMemory(MemoryItem):
    """A retrieved memory with its ranks: 1/(60+rank) per list, summed (reciprocal rank fusion)."""

    lexical_rank: int | None = None
    vector_rank: int | None = None
    fused_score: float | None = None


def lifecycle(item: MemoryItem) -> Literal["active", "pending", "invalidated"]:
    return "invalidated" if item.invalidated_at is not None else "active" if item.active else "pending"


AGENT_LABELS = {"owner_console": "Owner (console)", "owner_mcp": "Owner (MCP)", "supervisor_chat": "Supervisor chat", "factory": "Factory"}


def agent_node(proposed_by: ProposedBy) -> str:
    return f"agent:{proposed_by.channel}" + (f":{proposed_by.role}" if proposed_by.role else "")


def agent_label(proposed_by: ProposedBy) -> str:
    return AGENT_LABELS[proposed_by.channel] + (f" / {proposed_by.role}" if proposed_by.role else "")


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


# Overlap detection is deterministic and bounded: the newest OVERLAP_CANDIDATES active or pending memories of
# the project are compared with a proposal. Lexical similarity is the mean of the Jaccard similarity of normalized
# word sets and of word 2-shingles; with embeddings on both sides the cosine similarity is also considered.
# A pair is an overlap when lexical >= OVERLAP_THRESHOLD or cosine >= VECTOR_OVERLAP_THRESHOLD.
OVERLAP_THRESHOLD = 0.4
VECTOR_OVERLAP_THRESHOLD = 0.92
OVERLAP_CANDIDATES = 500
MAX_OVERLAP_LINKS = 10
MAX_DISTINCT_TERMS = 12
STOPWORDS = frozenset("a an and are as at be by for from has have in is it its of on or that the this to was were will with".split())


def normalized_tokens(text: str) -> list[str]:
    return [token for token in re.findall(r"\w+", text.casefold()) if len(token) > 1 and token not in STOPWORDS]


def jaccard(left: set, right: set) -> float:
    union = left | right
    return len(left & right) / len(union) if union else 0.0


def lexical_similarity(left: list[str], right: list[str]) -> float:
    words = jaccard(set(left), set(right))
    if len(left) < 2 or len(right) < 2:
        return words
    return (words + jaccard(set(zip(left, left[1:], strict=False)), set(zip(right, right[1:], strict=False)))) / 2


def overlap(proposal: str, existing: str, cosine: float | None = None) -> dict | None:
    left, right = normalized_tokens(proposal), normalized_tokens(existing)
    lexical = lexical_similarity(left, right)
    if lexical < OVERLAP_THRESHOLD and (cosine is None or cosine < VECTOR_OVERLAP_THRESHOLD):
        return None
    return {"score": round(max(lexical, cosine or 0.0), 4), "lexical": round(lexical, 4),
            "cosine": None if cosine is None else round(cosine, 4), "method": "shingle_jaccard_v1",
            "only_source": sorted(set(left) - set(right))[:MAX_DISTINCT_TERMS],
            "only_target": sorted(set(right) - set(left))[:MAX_DISTINCT_TERMS]}


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

    async def _memory_target(self, conn, item: MemoryItem, target_id: str, *, lock=False) -> MemoryItem:
        if target_id == item.id:
            raise DomainError("MEMORY_LINK_INVALID", "A memory cannot link to itself", 422)
        statement = "SELECT data FROM memories WHERE id=%s AND project_id=%s FOR UPDATE" if lock else "SELECT data FROM memories WHERE id=%s AND project_id=%s"
        row = await (await conn.execute(statement,
                                        (target_id, item.project_id))).fetchone()
        if row is None:
            raise DomainError("MEMORY_LINK_INVALID", "Linked memories must belong to the same project", 422)
        return item_from(row["data"])

    async def _link(self, conn, item: MemoryItem, kind: str, target_type: str, target_id: str, attrs: dict | None = None):
        await conn.execute("""INSERT INTO memory_links(project_id,source_id,kind,target_type,target_id,attrs)
            VALUES(%s,%s,%s,%s,%s,%s) ON CONFLICT(source_id,kind,target_type,target_id) DO NOTHING""",
            (item.project_id, item.id, kind, target_type, target_id, Jsonb(attrs or {})))

    async def create_memory(self, item: MemoryItem, embedding: list[float] | None = None):
        async with self.connection() as conn:
            if item.supersedes is not None:
                await self._memory_target(conn, item, item.supersedes)
            created = await (await conn.execute("INSERT INTO memories(id,project_id,data,embedding) VALUES(%s,%s,%s,%s) ON CONFLICT(id) DO NOTHING RETURNING id",
                (item.id, item.project_id, Jsonb(json.loads(item.model_dump_json())), str(embedding) if embedding else None))).fetchone()
            if created:
                await self._insert_citations(conn, item)
                if item.supersedes is not None:
                    await self._link(conn, item, "supersedes", "memory", item.supersedes, {"recorded_at": "proposal"})
                if not item.active:
                    await self._record_overlaps(conn, item, embedding)
            row = await (await conn.execute("SELECT data FROM memories WHERE id=%s", (item.id,))).fetchone()
            return item_from(row["data"])

    async def _record_overlaps(self, conn, item: MemoryItem, embedding: list[float] | None):
        """Store ``overlaps`` links to similar active or pending memories; never a conflict verdict."""
        candidates = await (await conn.execute("""SELECT id,data->>'content' AS content,
                CASE WHEN %(vector)s::text IS NOT NULL AND embedding IS NOT NULL THEN 1-(embedding <=> %(vector)s::vector) END AS cosine
            FROM memories WHERE project_id=%(project)s AND id<>%(id)s AND data->>'invalidated_at' IS NULL
                AND coalesce(data->'proposed_by'->>'channel','')<>'factory'
            ORDER BY (data->>'created_at')::timestamptz DESC,id DESC LIMIT %(limit)s""",
            {"vector": str(embedding) if embedding else None, "project": item.project_id, "id": item.id, "limit": OVERLAP_CANDIDATES})).fetchall()
        found = [(row["id"], result) for row in candidates
                 if (result := overlap(item.content, row["content"], None if row["cosine"] is None else float(row["cosine"]))) is not None]
        for target, attrs in sorted(found, key=lambda value: (-value[1]["score"], value[0]))[:MAX_OVERLAP_LINKS]:
            await self._link(conn, item, "overlaps", "memory", target, attrs)

    async def set_memory_state(self, memory_id: str, approve: bool, *, scope: str | None = None,
                               supersedes: str | None = None, related: list[str] | None = None):
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
                if supersedes is not None:
                    item.supersedes = supersedes
                if item.supersedes is not None:
                    # Supersession is the owner's decision: the older memory is invalidated atomically with this approval.
                    older = await self._memory_target(conn, item, item.supersedes, lock=True)
                    await self._link(conn, item, "supersedes", "memory", older.id, {"recorded_at": "approval"})
                    if older.invalidated_at is None:
                        older.active, older.invalidated_at = False, now()
                        await conn.execute("UPDATE memories SET data=%s WHERE id=%s", (Jsonb(json.loads(older.model_dump_json())), older.id))
                for target in dict.fromkeys(related or []):
                    await self._memory_target(conn, item, target)
                    await self._link(conn, item, "related", "memory", target, {"recorded_at": "approval"})
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
        """Up to eight recallable memories with their lexical and vector ranks and fused RRF score."""
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
                    SELECT scoped.data,scores.score AS fused_score,lexical.position AS lexical_rank,semantic.position AS vector_rank
                    FROM scores JOIN scoped USING(id) LEFT JOIN lexical USING(id) LEFT JOIN semantic USING(id)
                    ORDER BY scores.score DESC,id LIMIT 8
                """).format(recallable=sql.SQL(RECALLABLE), query_function=query_function)
            else:
                statement = sql.SQL("""SELECT m.data,row_number() OVER (ORDER BY ts_rank(m.document,{query_function}('simple',%(query)s)) DESC,m.id) AS lexical_rank,
                        NULL::bigint AS vector_rank,NULL::numeric AS fused_score
                    FROM memories m WHERE {recallable} AND m.document @@ {query_function}('simple',%(query)s)
                    ORDER BY lexical_rank LIMIT 8""").format(recallable=sql.SQL(RECALLABLE), query_function=query_function)
            rows = await (await conn.execute(statement, values)).fetchall()
        return [RecalledMemory(**item_from(row["data"]).model_dump(), lexical_rank=row["lexical_rank"], vector_rank=row["vector_rank"],
                               fused_score=round(float(row["fused_score"]) if row["fused_score"] is not None else 1 / (60 + row["lexical_rank"]), 6))
                for row in rows]

    async def memory_graph(self, project_id: str, focus: str | None, depth: int, limit: int) -> dict:
        memory_kinds = ["supersedes", "related", "overlaps"]
        truncated = False
        async with self.connection() as conn:
            if focus is not None:
                found = await (await conn.execute("SELECT 1 FROM memories WHERE id=%s AND project_id=%s", (focus, project_id))).fetchone()
                if found is None:
                    raise DomainError("MEMORY_NOT_FOUND", "Memory not found in this project", 404)
                selected, frontier = [focus], [focus]
                for _ in range(depth):
                    rows = await (await conn.execute("""SELECT source_id,target_id FROM memory_links WHERE project_id=%s AND target_type='memory'
                        AND kind=ANY(%s) AND (source_id=ANY(%s) OR target_id=ANY(%s)) ORDER BY id LIMIT %s""",
                        (project_id, memory_kinds, frontier, frontier, limit * 4))).fetchall()
                    truncated |= len(rows) == limit * 4
                    following = [value for row in rows for value in (row["source_id"], row["target_id"]) if value not in selected]
                    following = list(dict.fromkeys(following))
                    selected.extend(following)
                    frontier = following
                    if not frontier:
                        break
                if len(selected) > limit:
                    selected, truncated = selected[:limit], True
            else:
                cap = max(1, limit // 3)
                rows = await (await conn.execute("""SELECT id FROM memories WHERE project_id=%s
                    ORDER BY (data->>'created_at')::timestamptz DESC,id DESC LIMIT %s""", (project_id, cap + 1))).fetchall()
                selected = [row["id"] for row in rows[:cap]]
                truncated |= len(rows) > cap
            memories = {row["id"]: item_from(row["data"]) for row in await (await conn.execute(
                "SELECT id,data FROM memories WHERE project_id=%s AND id=ANY(%s)", (project_id, selected))).fetchall()}
            links = await (await conn.execute("""SELECT source_id,kind,target_type,target_id,attrs FROM memory_links
                WHERE project_id=%s AND source_id=ANY(%s) ORDER BY id LIMIT %s""", (project_id, selected, limit * 8))).fetchall()
            truncated |= len(links) == limit * 8
            runs = {row["id"]: row for row in await (await conn.execute("""SELECT id,data->>'objective' AS objective,data->>'status' AS status
                FROM work_orders WHERE project_id=%s AND id=ANY(%s)""", (project_id, sorted({item.source_work_id for item in memories.values()})))).fetchall()}
        nodes: dict[str, dict] = {}
        edges: list[dict] = []

        def add(node_id, node_type, label, attrs):
            nonlocal truncated
            if node_id in nodes:
                return True
            if len(nodes) >= limit:
                truncated = True
                return False
            nodes[node_id] = {"id": node_id, "type": node_type, "label": label, "attrs": attrs}
            return True

        def connect(source, target, kind, attrs=None):
            if source in nodes and target in nodes:
                edges.append({"source": source, "target": target, "kind": kind, "attrs": attrs or {}})

        ordered = [memories[value] for value in selected if value in memories]
        for item in ordered:
            add(f"memory:{item.id}", "memory", " ".join(item.content.split())[:80],
                {"kind": item.kind, "state": lifecycle(item), "scope": item.scope, "source_commit": item.source_commit})
        for link in links:
            if link["target_type"] == "file":
                add(f"file:{link['target_id']}", "file", link["target_id"], {})
        for item in ordered:
            run = runs.get(item.source_work_id)
            if run is not None:
                add(f"run:{run['id']}", "run", " ".join((run["objective"] or "").split())[:80], {"status": run["status"]})
            add(f"commit:{item.source_commit}", "commit", item.source_commit[:12], {"sha": item.source_commit})
            if item.proposed_by is not None:
                add(agent_node(item.proposed_by), "agent", agent_label(item.proposed_by),
                    {"channel": item.proposed_by.channel, "role": item.proposed_by.role})
        for link in links:
            target = f"{link['target_type']}:{link['target_id']}"
            connect(f"memory:{link['source_id']}", target, link["kind"], dict(link["attrs"]))
        for item in ordered:
            source = f"memory:{item.id}"
            connect(source, f"run:{item.source_work_id}", "from_run")
            connect(source, f"commit:{item.source_commit}", "at_commit")
            if item.proposed_by is not None:
                connect(source, agent_node(item.proposed_by), "proposed_by")
        return {"focus": focus, "depth": depth, "nodes": list(nodes.values()), "edges": edges, "truncated": truncated}

    async def record_memory_recall(self, recall: dict):
        async with self.connection() as conn:
            await conn.execute("""INSERT INTO memory_recalls(id,project_id,work_id,role,stage,commit,outcome,error_code,memory_ids,data)
                VALUES(%(id)s,%(project_id)s,%(work_id)s,%(role)s,%(stage)s,%(commit)s,%(outcome)s,%(error_code)s,%(memory_ids)s,%(data)s)
                ON CONFLICT(id) DO NOTHING""", {**recall, "data": Jsonb(recall["data"])})

    async def memory_recalls(self, project_id: str, *, work_id: str | None = None, memory_id: str | None = None,
                             cursor: int | None = None, limit: int = 50) -> tuple[list[dict], int | None]:
        async with self.connection() as conn:
            rows = await (await conn.execute("""SELECT seq,id,project_id,work_id,role,stage,commit,outcome,error_code,memory_ids,data,created_at
                FROM memory_recalls WHERE project_id=%(project)s AND (%(work)s::text IS NULL OR work_id=%(work)s)
                AND (%(memory)s::text IS NULL OR memory_ids @> ARRAY[%(memory)s::text]) AND (%(cursor)s::bigint IS NULL OR seq<%(cursor)s)
                ORDER BY seq DESC LIMIT %(limit)s""", {"project": project_id, "work": work_id, "memory": memory_id,
                                                      "cursor": cursor, "limit": limit + 1})).fetchall()
        return rows[:limit], rows[limit - 1]["seq"] if len(rows) > limit else None

    async def memory_recall_stats(self, memory_ids: list[str]) -> dict[str, dict]:
        async with self.connection() as conn:
            rows = await (await conn.execute("""SELECT memory_id,count(*) FILTER(WHERE outcome='recalled') AS recall_count,
                    max(created_at) FILTER(WHERE outcome='recalled') AS last_recalled_at,count(*) FILTER(WHERE outcome='refused') AS refused_count
                FROM memory_recalls r CROSS JOIN LATERAL unnest(r.memory_ids) AS memory_id
                WHERE r.memory_ids && %s GROUP BY memory_id""", (memory_ids,))).fetchall()
        return {row["memory_id"]: row for row in rows if row["memory_id"] in memory_ids}

    async def newest_indexed_commit(self, project_id: str) -> str | None:
        """The commit of the latest completed ingestion, else the most recently captured index."""
        async with self.connection() as conn:
            row = await (await conn.execute("""SELECT coalesce(
                (SELECT j.data->>'source_commit' FROM repository_ingestions j JOIN repository_indexes i ON i.project_id=j.project_id
                    AND i.source_commit=j.data->>'source_commit' AND i.index_version=%(version)s
                 WHERE j.project_id=%(project)s AND j.data->>'state'='completed'
                 ORDER BY (j.data->>'finished_at')::timestamptz DESC,j.id DESC LIMIT 1),
                (SELECT source_commit FROM repository_indexes WHERE project_id=%(project)s AND index_version=%(version)s
                 ORDER BY captured_at DESC,source_commit LIMIT 1)) AS commit""", {"project": project_id, "version": index_version()})).fetchone()
        return row["commit"]

    async def memory_page(self, project_id: str, *, commit: str | None, state: str | None = None, kind: str | None = None,
                          query: str | None = None, after: tuple[str, str] | None = None, limit: int = 50,
                          memory_id: str | None = None) -> list[dict]:
        """Newest first; each row carries the current validity at ``commit`` and link counts in both directions."""
        # ILIKE uses backslash as its escape character; user text matches literally.
        pattern = None if query is None else "%" + query.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
        async with self.connection() as conn:
            if commit is not None:
                await self._ensure_validity(conn, project_id, commit)
            statement = sql.SQL("""SELECT m.id,m.data,
                    (SELECT jsonb_build_object('state',v.state,'basis',v.basis,'changed_paths',v.changed_paths,'checked_at',v.checked_at)
                        FROM memory_validity v WHERE v.memory_id=m.id AND v.commit=%(commit)s ORDER BY (v.state='valid') DESC,v.id DESC LIMIT 1) AS validity,
                    (SELECT coalesce(jsonb_object_agg(k.kind,k.n),'{{}}'::jsonb) FROM (SELECT l.kind,count(*) AS n FROM memory_links l
                        WHERE l.project_id=m.project_id AND (l.source_id=m.id OR (l.target_type='memory' AND l.target_id=m.id)) GROUP BY l.kind) k) AS link_counts
                FROM memories m WHERE m.project_id=%(project)s AND {state}
                    AND (%(kind)s::text IS NULL OR m.data->>'kind'=%(kind)s) AND (%(memory)s::text IS NULL OR m.id=%(memory)s)
                    AND (%(pattern)s::text IS NULL OR m.data->>'content' ILIKE %(pattern)s)
                    AND (%(after_at)s::timestamptz IS NULL OR ((m.data->>'created_at')::timestamptz,m.id)<(%(after_at)s::timestamptz,%(after_id)s::text))
                ORDER BY (m.data->>'created_at')::timestamptz DESC,m.id DESC LIMIT %(limit)s""").format(state=sql.SQL(STATE_FILTERS[state]))
            return await (await conn.execute(statement, {"project": project_id, "commit": commit, "kind": kind, "pattern": pattern, "memory": memory_id,
                "after_at": after[0] if after else None, "after_id": after[1] if after else None, "limit": limit})).fetchall()

    async def memory_links_of(self, memory_id: str, limit: int = 200) -> tuple[list[dict], list[dict]]:
        async with self.connection() as conn:
            outgoing = await (await conn.execute("""SELECT source_id,kind,target_type,target_id,attrs,created_at FROM memory_links
                WHERE source_id=%s ORDER BY id LIMIT %s""", (memory_id, limit))).fetchall()
            incoming = await (await conn.execute("""SELECT source_id,kind,target_type,target_id,attrs,created_at FROM memory_links
                WHERE target_type='memory' AND target_id=%s ORDER BY id LIMIT %s""", (memory_id, limit))).fetchall()
        return outgoing, incoming

    async def memory_overlaps(self, project_id: str, memory_ids: list[str], limit: int = 500) -> list[dict]:
        async with self.connection() as conn:
            return await (await conn.execute("""SELECT l.source_id,l.target_id,l.attrs,s.data AS source,t.data AS target FROM memory_links l
                JOIN memories s ON s.id=l.source_id JOIN memories t ON t.id=l.target_id
                WHERE l.project_id=%s AND l.kind='overlaps' AND l.target_type='memory' AND (l.source_id=ANY(%s) OR l.target_id=ANY(%s))
                ORDER BY l.id LIMIT %s""", (project_id, memory_ids, memory_ids, limit))).fetchall()

    async def memory_work_summary(self, project_id: str, work_id: str) -> dict | None:
        async with self.connection() as conn:
            return await (await conn.execute("""SELECT id,data->>'objective' AS objective,data->>'status' AS status FROM work_orders
                WHERE id=%s AND project_id=%s""", (work_id, project_id))).fetchone()
