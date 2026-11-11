import io
import tarfile

import pytest
from pydantic import ValidationError

from sabre.models import DomainError
from sabre.publisher import validate_commit_message
from sabre.release_candidates import (
    ReleaseAuthorization,
    ReleasePreparation,
    dependency_inventory,
    source_material,
)
from sabre.security import SecretGuard


@pytest.mark.parametrize("message", ["Update things", "fix: ", "fix: bad\tcontrol", "feat(scope):\nNo subject", "fix: subject\nMissing blank separator"])
def test_conventional_commit_validation_rejects_invalid_messages(message):
    with pytest.raises(DomainError) as error:
        validate_commit_message(message)
    assert error.value.code == "INVALID_COMMIT_MESSAGE"


@pytest.mark.parametrize("value", [False, True, "true", 1, None])
def test_owner_authorization_is_explicit_and_version_strict(value):
    payload = {"version": 1, "expected_revision": 0, "candidate_digest": "a" * 64, "authorize_publication": value}
    if value is True:
        assert ReleaseAuthorization(**payload).authorize_publication
    else:
        with pytest.raises(ValidationError):
            ReleaseAuthorization(**payload)


def test_source_archive_has_no_author_metadata_and_preserves_tracked_project_skills():
    snapshot = {"files": [{"path": ".claude/skills/review/SKILL.md", "content": "Reviewed project instructions"},
                          {"path": "script.py", "content": "print('ok')", "executable": True}]}
    files, archive = source_material(snapshot, SecretGuard())
    with tarfile.open(fileobj=io.BytesIO(archive)) as tar:
        assert tar.getnames() == sorted(files)
        assert all(member.uid == 0 and member.gid == 0 and not member.uname and not member.gname for member in tar.getmembers())
        assert tar.getmember("script.py").mode == 0o755
    assert b"author@example.org" not in archive


@pytest.mark.parametrize("path", ["auth.json", ".codex/auth.json", ".claude/.credentials.json", ".codex/sessions/state.jsonl", ".env"])
def test_source_session_material_is_rejected_without_silently_changing_the_snapshot(path):
    with pytest.raises(DomainError):
        source_material({"files": [{"path": path, "content": "Private session metadata"}]}, SecretGuard())


def test_inventory_projects_only_dependency_identity_not_private_lock_metadata():
    inventory = dependency_inventory({"uv.lock": b'[[package]]\nname="library"\nversion="1.2.3"\nsource={registry="https://private.example"}\nauthor="author@example.org"'}, "1.0.0")
    assert inventory["components"] == [{"type": "library", "name": "library", "version": "1.2.3"}]
    assert "author@example.org" not in str(inventory) and "private.example" not in str(inventory)
    with pytest.raises(DomainError):
        dependency_inventory({"package.json": b'{"dependencies":{"unresolved":"*"}}'}, "1.0.0")
    with pytest.raises(DomainError):
        dependency_inventory({"uv.lock": b'[[package]]\nname="library"\nversion="author@example.org"'}, "1.0.0")


@pytest.mark.parametrize("version", ["1.0", "1.0.0-01", "1.0.0-a..b", "../1.0.0"])
def test_release_version_cannot_be_ambiguous_or_change_target_paths(version):
    with pytest.raises(ValidationError):
        ReleasePreparation(version=1, work_id="work", package_version=version, idempotency_key="candidate-key", required_checks=["unit"])
