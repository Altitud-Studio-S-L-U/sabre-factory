"""Rebuildable source navigation; current workspace snapshots remain authoritative."""

import hashlib
import json
import os
import re
import tomllib
from bisect import bisect_right
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from uuid import uuid4

from sabre.artifacts import ArtifactStore
from sabre.models import DomainError
from sabre.security import SecretGuard

INDEX_VERSION = 1
MAX_FILE_BYTES = 1_048_576
MAX_FILE_LINES = 20_000
MAX_RESPONSE_BYTES = 12_288
MAX_BRIEF_FILES = 40
MAX_PATCH_BRIEF_FILES = 12
MAX_MATCHES = 20
MAX_RANGE_LINES = 120
MANIFESTS = {"package.json", "pyproject.toml", "requirements.txt", "Cargo.toml", "go.mod"}


def encoded(value) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()


def response_size(value) -> int:
    return len(json.dumps(value, ensure_ascii=False).encode())


def source_path(value: str) -> str:
    path = PurePosixPath(value)
    if not value or len(value) > 1024 or "\\" in value or path.is_absolute() or any(part in {"", ".", ".."} for part in value.split("/")):
        raise DomainError("INVALID_SOURCE_PATH", "The context path is invalid", 422)
    return value


def area_evidence(path: str, content: str) -> list[dict]:
    """Only recognized manifests/configuration establish an area, never a guessed architecture."""
    name = PurePosixPath(path).name
    evidence = []
    if name in {"Dockerfile", "compose.yml", "compose.yaml", "docker-compose.yml", "docker-compose.yaml"} or path.endswith(".tf") or path.startswith(".github/workflows/"):
        evidence.append({"area": "infrastructure", "basis": "configuration", "path": path})
    dependencies: set[str] = set()
    if len(content.encode()) <= 262_144:
        try:
            if name == "package.json":
                data = json.loads(content)
                if isinstance(data, dict):
                    for section in ("dependencies", "devDependencies"):
                        if isinstance(data.get(section), dict):
                            dependencies.update(data[section])
            elif name == "pyproject.toml":
                data = tomllib.loads(content)
                values = data.get("project", {}).get("dependencies", [])
                if isinstance(values, list):
                    dependencies.update(re.split(r"[\s\[<>=!~;]", item, maxsplit=1)[0].lower() for item in values if isinstance(item, str))
        except (ValueError, TypeError, AttributeError, RecursionError):
            pass  # An invalid manifest is still visible; it cannot establish a framework.
    for area, known in (("frontend", {"react", "vue", "svelte", "@angular/core", "next"}), ("backend", {"fastapi", "django", "flask", "express", "fastify", "@nestjs/core"})):
        for dependency in sorted(dependencies & known):
            evidence.append({"area": area, "basis": f"dependency:{dependency}", "path": path})
    return evidence


@dataclass(frozen=True)
class SourceFile:
    path: str
    content: str
    content_digest: str
    indexable: bool


class ProjectContext:
    def __init__(self, artifacts: ArtifactStore, executor, guard: SecretGuard):
        self.artifacts, self.executor, self.guard = artifacts, executor, guard

    def _files(self, snapshot: dict) -> dict[str, SourceFile]:
        self.guard.check_snapshot(snapshot)
        files = {}
        for entry in snapshot["files"]:
            path = source_path(entry["path"])
            if path in files:
                raise DomainError("INVALID_SNAPSHOT", "The snapshot contains duplicate paths", 422)
            if entry.get("encoding", "utf-8") != "utf-8":
                continue
            content = entry["content"]
            raw = content.encode()
            lines = content.count("\n") + bool(content and not content.endswith("\n"))
            files[path] = SourceFile(path, content, hashlib.sha256(raw).hexdigest(), len(raw) <= MAX_FILE_BYTES and lines <= MAX_FILE_LINES)
        return files

    def _reference(self, identity: dict) -> Path:
        key = hashlib.sha256(encoded(identity)).hexdigest()
        path = self.artifacts.root
        for part in ("project-context", f"v{INDEX_VERSION}", key[:2]):
            path /= part
            if path.is_symlink():
                raise DomainError("UNSAFE_ARTIFACT_PATH", "The context cache contains an unexpected link")
            path.mkdir(exist_ok=True)
        target = path / key
        if target.is_symlink() or not target.resolve().is_relative_to(self.artifacts.root):
            raise DomainError("UNSAFE_ARTIFACT_PATH", "The context reference is unsafe")
        return target

    def _build_index(self, identity: dict, source: SourceFile) -> dict:
        starts = [0] if source.content else []
        starts += [match.end() for match in re.finditer("\n", source.content) if match.end() < len(source.content)]
        return {**identity, "line_starts": starts, "areas": area_evidence(source.path, source.content)}

    def _index(self, project_id: str, source: SourceFile) -> dict:
        if not source.indexable:
            raise DomainError("SOURCE_INDEX_LIMIT", "The file exceeds the navigation index limits", 422)
        identity = {"version": INDEX_VERSION, "project_id": project_id, "path": source.path, "content_digest": source.content_digest}
        reference = self._reference(identity)
        try:
            if reference.stat().st_size != 64:
                raise ValueError
            artifact = reference.read_text(encoding="ascii")
            if not re.fullmatch(r"[a-f0-9]{64}", artifact):
                raise ValueError
            raw = self.artifacts.get(artifact)
            if len(raw) > 400_000:
                raise ValueError
            value = json.loads(raw)
            if not isinstance(value, dict) or any(value.get(key) != item for key, item in identity.items()):
                raise ValueError
            starts = value.get("line_starts")
            if not isinstance(starts, list) or len(starts) > MAX_FILE_LINES or any(type(item) is not int for item in starts):
                raise ValueError
            if starts != sorted(set(starts)) or bool(starts) != bool(source.content) or starts and starts[0] != 0:
                raise ValueError
            if any(item < 0 or item >= len(source.content) or item and source.content[item - 1] != "\n" for item in starts):
                raise ValueError
            if len(starts) != source.content.count("\n") + bool(source.content and not source.content.endswith("\n")) or not isinstance(value.get("areas"), list):
                raise ValueError
            self.guard.check(value)
            return value
        except DomainError as error:
            # Immutable artifact corruption must fail closed, never overwrite shared evidence.
            if error.code != "ARTIFACT_NOT_FOUND":
                raise
        except (FileNotFoundError, ValueError, UnicodeError, RecursionError):
            pass
        value = self._build_index(identity, source)
        self.guard.check(value)
        artifact = self.artifacts.put(encoded(value))
        temporary = reference.with_name(f".{reference.name}.{uuid4().hex}.tmp")
        try:
            with temporary.open("x", encoding="ascii") as stream:
                stream.write(artifact)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, reference)
        finally:
            temporary.unlink(missing_ok=True)
        return value

    async def for_role(self, project_id: str, work_id: str, snapshot: dict, role: str, instruction: str, *, mode: str = ""):
        self.guard.check([project_id, work_id, role, instruction])
        files = self._files(snapshot)
        tokens = set(re.findall(r"[\w.-]{3,}", instruction.casefold()))

        def rank(source: SourceFile):
            path = source.path.casefold()
            score = sum(4 for token in tokens if token in path)
            score += 2 if PurePosixPath(path).name in MANIFESTS else 0
            score += 3 if role in {"qa", "reviewer"} and ("test" in path or "spec" in path) else 0
            score += 3 if role == "security" and any(word in path for word in ("auth", "security", "lock", "docker")) else 0
            # Broad path tokens such as "src" must not displace the execution manifest.
            priority = 0
            if mode == "patch":
                name = PurePosixPath(path).name
                priority = 0 if name in tokens else 1 if name in MANIFESTS else 2
            return priority, -score, path

        brief: dict = {"project_id": project_id, "work_id": work_id, "snapshot_digest": snapshot["digest"], "source_commit": snapshot["base_commit"],
                 "role": role, "source": "current_workspace_snapshot", "untrusted": True, "total_files": len(snapshot["files"]),
                 "text_files": len(files), "files": [], "omitted_files": len(snapshot["files"]),
                 "usage": "Navigation hints only. Search literal source text, then read bounded line ranges with its content_digest. Tools refresh the snapshot. Unlisted files may still be relevant."}
        limit = MAX_PATCH_BRIEF_FILES if mode == "patch" else MAX_BRIEF_FILES
        for source in sorted(files.values(), key=rank)[:limit]:
            index = self._index(project_id, source) if source.indexable else None
            item = {"path": source.path, "content_digest": source.content_digest, "indexable": source.indexable,
                    "lines": len(index["line_starts"]) if index else None, "areas": index["areas"] if index else []}
            brief["files"].append(item)
            brief["omitted_files"] -= 1
            if response_size(brief) > MAX_RESPONSE_BYTES:
                brief["files"].pop()
                brief["omitted_files"] += 1
                break
        self.guard.check(brief)
        return RoleSourceContext(self, project_id, work_id, brief)


@dataclass
class RoleSourceContext:
    manager: ProjectContext
    project_id: str
    work_id: str
    brief: dict

    async def _current(self):
        snapshot = await self.manager.executor.snapshot(self.work_id)
        files = self.manager._files(snapshot)
        provenance = {"project_id": self.project_id, "work_id": self.work_id, "snapshot_digest": snapshot["digest"], "source_commit": snapshot["base_commit"], "source": "current_workspace_snapshot", "untrusted": True}
        binary_paths = [entry["path"] for entry in snapshot["files"] if entry.get("encoding", "utf-8") != "utf-8"]
        return provenance, files, binary_paths

    async def edit_source(self, path: str, content_digest: str, old_text: str, new_text: str, expected_count: int = 1):
        source_path(path)
        if not isinstance(old_text, str) or not old_text or not isinstance(new_text, str) or len(old_text.encode()) > MAX_RESPONSE_BYTES or len(new_text.encode()) > MAX_RESPONSE_BYTES or type(expected_count) is not int or not 1 <= expected_count <= 20:
            raise DomainError("INVALID_TOOL_ARGUMENTS", "The edit must contain bounded text and an exact match count", 422)
        self.manager.guard.check([old_text, new_text])
        _, files, _ = await self._current()
        source = files.get(path)
        if source is None:
            raise DomainError("SOURCE_NOT_FOUND", "The text file no longer belongs to the current snapshot", 404)
        if source.content_digest != content_digest:
            raise DomainError("SOURCE_CONTEXT_STALE", "The file changed; read it again before editing", 409)
        occurrences = source.content.count(old_text)
        if occurrences != expected_count:
            raise DomainError("SOURCE_EDIT_COUNT", "Matches differ from the authorized count; no changes were written", 409)
        content = source.content.replace(old_text, new_text)
        self.manager.guard.check(content)
        # The broker repeats the digest comparison under its workspace lock.
        await self.manager.executor.write_file(self.work_id, path, content, expected_content_digest=content_digest)
        return {"path": path, "previous_content_digest": content_digest,
                "content_digest": hashlib.sha256(content.encode()).hexdigest(), "occurrences": occurrences}

    async def search_source(self, query: str, path_prefix: str = "", offset: int = 0, limit: int = MAX_MATCHES, snapshot_digest: str = ""):
        if not 1 <= len(query) <= 200 or "\n" in query or "\r" in query or not 0 <= offset <= 2147483647 or not 1 <= limit <= MAX_MATCHES:
            raise DomainError("INVALID_TOOL_ARGUMENTS", "The search exceeds navigation limits", 422)
        if path_prefix:
            source_path(path_prefix.rstrip("/"))
        provenance, files, binary_paths = await self._current()
        if snapshot_digest and snapshot_digest != provenance["snapshot_digest"] or offset and not snapshot_digest:
            raise DomainError("SOURCE_CONTEXT_STALE", "The snapshot changed; restart the search", 409)
        selected = [source for path, source in sorted(files.items()) if path.startswith(path_prefix)]
        skipped = sum(not source.indexable for source in selected) + sum(path.startswith(path_prefix) for path in binary_paths)
        result: dict = {**provenance, "matches": [], "next_offset": None, "skipped_files": skipped, "truncated": False}
        found = 0
        for source in selected:
            if not source.indexable:
                continue
            starts = self.manager._index(self.project_id, source)["line_starts"]
            position = source.content.find(query)
            while position >= 0:
                line_index = bisect_right(starts, position) - 1
                end = starts[line_index + 1] if line_index + 1 < len(starts) else len(source.content)
                if found >= offset:
                    preview_start = max(starts[line_index], position - 80)
                    preview = source.content[preview_start:min(end, preview_start + 384)].rstrip("\r\n")
                    item = {"path": source.path, "content_digest": source.content_digest, "line": line_index + 1, "preview": preview,
                            "preview_truncated": preview_start != starts[line_index] or end - preview_start > 384}
                    result["matches"].append(item)
                    if len(result["matches"]) > limit or response_size(result) > MAX_RESPONSE_BYTES - 100:
                        result["matches"].pop()
                        result["next_offset"], result["truncated"] = found, True
                        self.manager.guard.check(result)
                        return result
                found += 1
                position = source.content.find(query, end)
        self.manager.guard.check(result)
        return result

    async def read_file_range(self, path: str, content_digest: str, start_line: int, end_line: int):
        source_path(path)
        if not 1 <= start_line <= end_line or end_line - start_line >= MAX_RANGE_LINES:
            raise DomainError("INVALID_TOOL_ARGUMENTS", "The range must contain between 1 and 120 lines", 422)
        provenance, files, _ = await self._current()
        source = files.get(path)
        if source is None:
            raise DomainError("SOURCE_NOT_FOUND", "The text file no longer belongs to the current snapshot", 404)
        if source.content_digest != content_digest:
            raise DomainError("SOURCE_CONTEXT_STALE", "The file changed; search again before reading", 409)
        starts = self.manager._index(self.project_id, source)["line_starts"]
        if start_line > len(starts):
            raise DomainError("SOURCE_RANGE_INVALID", "The starting line does not exist", 422)
        actual_end = min(end_line, len(starts))
        result: dict = {**provenance, "path": path, "content_digest": source.content_digest, "start_line": start_line,
                  "end_line": actual_end, "total_lines": len(starts), "content": "", "truncated": False, "next_line": None}
        while actual_end >= start_line:
            stop = starts[actual_end] if actual_end < len(starts) else len(source.content)
            result.update(content=source.content[starts[start_line - 1]:stop], end_line=actual_end,
                          truncated=actual_end < min(end_line, len(starts)), next_line=actual_end + 1 if actual_end < min(end_line, len(starts)) else None)
            if response_size(result) <= MAX_RESPONSE_BYTES:
                self.manager.guard.check(result)
                return result
            actual_end -= 1
        raise DomainError("SOURCE_RANGE_LIMIT", "A line exceeds the context output limit", 422)
