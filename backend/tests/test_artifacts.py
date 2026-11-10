import hashlib

import pytest

from sabre import artifacts
from sabre.artifacts import ArtifactStore
from sabre.models import DomainError
from sabre.security import SecretGuard


def test_artifacts_round_trip_and_are_content_addressed(tmp_path):
    store = ArtifactStore(tmp_path)
    digest = store.put("evidence\n")
    assert store.put("evidence\n") == digest
    assert store.get(digest) == b"evidence\n"
    assert store.put(b"different") != digest


def test_corruption_and_digest_escape_are_rejected(tmp_path):
    store = ArtifactStore(tmp_path)
    digest = store.put(b"valid")
    (tmp_path / digest[:2] / digest).write_bytes(b"changed")
    with pytest.raises(DomainError) as error:
        store.get(digest)
    assert error.value.code == "ARTIFACT_CORRUPT"
    with pytest.raises(DomainError):
        store.get("../../outside")


def test_artifacts_cannot_persist_a_registered_secret(tmp_path):
    store = ArtifactStore(tmp_path, SecretGuard(["synthetic-private-value"]))
    with pytest.raises(DomainError):
        store.put("synthetic-private-value")
    assert not list(tmp_path.iterdir())


def test_interrupted_write_is_not_published_and_can_be_retried(tmp_path, monkeypatch):
    store = ArtifactStore(tmp_path)
    content = b"delivery evidence"
    digest = hashlib.sha256(content).hexdigest()

    def interrupted(descriptor):
        raise OSError("simulated storage failure")

    with monkeypatch.context() as context:
        context.setattr(artifacts.os, "fsync", interrupted)
        with pytest.raises(OSError):
            store.put(content)
    with pytest.raises(DomainError) as error:
        store.get(digest)
    assert error.value.code == "ARTIFACT_NOT_FOUND"
    assert store.put(content) == digest
    assert store.get(digest) == content
    assert not list(tmp_path.rglob("*.tmp"))
