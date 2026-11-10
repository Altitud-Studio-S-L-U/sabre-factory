"""Local immutable artifacts; callers keep only digests in graph state."""

import hashlib
import os
import re
from pathlib import Path
from uuid import uuid4

from sabre.models import DomainError


class ArtifactStore:
    def __init__(self, root: str | Path, guard=None):
        self.root = Path(root).resolve()
        self.root.mkdir(parents=True, exist_ok=True)
        self.guard = guard

    def _path(self, digest: str) -> Path:
        if not re.fullmatch(r"[0-9a-f]{64}", digest):
            raise DomainError("INVALID_DIGEST", "The artifact identifier is invalid", 422)
        shard = self.root / digest[:2]
        if shard.is_symlink():
            raise DomainError("UNSAFE_ARTIFACT_PATH", "The store contains an unexpected link")
        target = shard / digest
        if target.is_symlink():
            raise DomainError("UNSAFE_ARTIFACT_PATH", "The artifact is an unexpected link")
        return target

    def put(self, content: bytes | str) -> str:
        data = content.encode() if isinstance(content, str) else content
        if self.guard:
            self.guard.check(data.decode("utf-8", errors="replace"))
        digest = hashlib.sha256(data).hexdigest()
        target = self._path(digest)
        target.parent.mkdir(parents=True, exist_ok=True)
        temporary = target.with_name(f".{digest}.{uuid4().hex}.tmp")
        try:
            with temporary.open("xb") as stream:
                stream.write(data)
                stream.flush()
                os.fsync(stream.fileno())
            try:
                # Publish complete bytes atomically without replacing existing
                # content. Other processes never observe a partial artifact.
                os.link(temporary, target)
            except FileExistsError:
                if self.get(digest) != data:
                    raise DomainError("ARTIFACT_CORRUPT", "The existing artifact does not match") from None
            if os.name == "posix":
                directory = os.open(target.parent, os.O_RDONLY | os.O_DIRECTORY)
                try:
                    os.fsync(directory)
                finally:
                    os.close(directory)
        finally:
            temporary.unlink(missing_ok=True)
        return digest

    def get(self, digest: str) -> bytes:
        target = self._path(digest)
        try:
            data = target.read_bytes()
        except FileNotFoundError:
            raise DomainError("ARTIFACT_NOT_FOUND", "The artifact is unavailable", 404) from None
        if hashlib.sha256(data).hexdigest() != digest:
            raise DomainError("ARTIFACT_CORRUPT", "The artifact failed its integrity check")
        return data
