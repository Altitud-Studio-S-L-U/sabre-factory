import json
from types import SimpleNamespace
from unittest.mock import AsyncMock

import httpx
import pytest
from pydantic import SecretStr, ValidationError

from sabre.models import DomainError, now
from sabre.repo_creation import RepoCreationProposal, RepoCreationRequest, RepoCreationService, request_digest
from sabre.security import SecretGuard

TOKEN = "synthetic-repository-create-credential"


def proposal(**changes):
    request = RepoCreationRequest(**{"owner_type": "org", "owner": "fixture", "name": "new-repo", "idempotency_key": "fixture-request", **changes})
    return RepoCreationProposal(id="proposal-1", request=request, request_digest=request_digest(request), status="executing", revision=2,
        created_at=now(), updated_at=now(), approved_at=now(), started_at=now(), receipt=None, candidate=None, error_code=None)


def receipt(**changes):
    return {"id": 42, "full_name": "fixture/new-repo", "private": True, "created_at": "2026-11-07T12:00:00Z", "description": "", "html_url": "https://untrusted.invalid", "temp_clone_token": TOKEN, **changes}


def service(handler, current=None, token=TOKEN):
    current = current or proposal()
    credentials = SimpleNamespace(resolve=AsyncMock(return_value=SecretStr(token)), revision=("fixture",),
                                  ensure_enabled=AsyncMock(), assert_current=AsyncMock())
    result = RepoCreationService(None, credentials, SecretGuard([TOKEN]), client=httpx.AsyncClient(transport=httpx.MockTransport(handler)))
    result._claim = AsyncMock(return_value=(current, True))

    async def outcome(previous, status, **values):
        return previous.model_copy(update={"status": status, "revision": previous.revision + 1, **values})
    result._outcome = AsyncMock(side_effect=outcome)
    return result, credentials


async def test_creation_uses_only_separate_token_exact_approved_private_payload_and_projected_receipt():
    seen = []
    def respond(request):
        seen.append(request)
        return httpx.Response(404) if request.method == "GET" else httpx.Response(201, json=receipt())
    creation, credentials = service(respond)
    result = await creation.execute("proposal-1")
    assert result.status == "created" and result.receipt.id == 42
    assert result.receipt.url == "https://github.com/fixture/new-repo"
    assert TOKEN not in result.model_dump_json() and "untrusted.invalid" not in result.model_dump_json()
    credentials.resolve.assert_awaited_once_with("github.create")
    credentials.ensure_enabled.assert_awaited_once_with("github.create")
    credentials.assert_current.assert_awaited_once_with(("fixture",))
    assert [(item.method, item.url.path) for item in seen] == [("GET", "/repos/fixture/new-repo"), ("POST", "/orgs/fixture/repos")]
    assert json.loads(seen[1].content) == {"name": "new-repo", "private": True, "description": "", "auto_init": False}
    assert seen[1].headers["Authorization"] == f"Bearer {TOKEN}"
    await creation.client.aclose()


async def test_user_owner_is_verified_before_existence_or_creation():
    seen = []
    def respond(request):
        seen.append(request)
        return httpx.Response(200, json={"login": "another-user", "email": TOKEN})
    current = proposal()
    current.request.owner_type = "user"
    current.request_digest = request_digest(current.request)
    creation, _ = service(respond, current)
    result = await creation.execute(current.id)
    assert result.status == "failed" and result.error_code == "REPOSITORY_OWNER_MISMATCH"
    assert [(item.method, item.url.path) for item in seen] == [("GET", "/user")]
    await creation.client.aclose()


async def test_public_user_creation_requires_matching_identity_and_explicit_visibility_payload():
    seen = []
    def respond(request):
        seen.append(request)
        if request.url.path == "/user":
            return httpx.Response(200, json={"login": "fixture"})
        return httpx.Response(404) if request.method == "GET" else httpx.Response(201, json=receipt(private=False))
    creation, _ = service(respond, proposal(owner_type="user", visibility="public"))
    result = await creation.execute("proposal-1")
    assert result.status == "created" and result.receipt.visibility == "public"
    assert [(item.method, item.url.path) for item in seen] == [("GET", "/user"), ("GET", "/repos/fixture/new-repo"), ("POST", "/user/repos")]
    assert json.loads(seen[-1].content)["private"] is False
    await creation.client.aclose()


@pytest.mark.parametrize("change", ["disabled", "rotated"])
async def test_revocation_during_preflight_prevents_creation(change):
    seen = []
    def respond(request):
        seen.append(request)
        if change == "disabled":
            credentials.ensure_enabled.side_effect = DomainError("INTEGRATION_DISABLED", "Desactivada", 409)
        else:
            credentials.assert_current.side_effect = DomainError("CREDENTIALS_CHANGED", "Cambiada", 409)
        return httpx.Response(404)
    creation, credentials = service(respond)
    result = await creation.execute("proposal-1")
    assert result.status == "failed"
    assert result.error_code == ("INTEGRATION_DISABLED" if change == "disabled" else "CREDENTIALS_CHANGED")
    assert [(item.method, item.url.path) for item in seen] == [("GET", "/repos/fixture/new-repo")]
    assert result.receipt is None
    await creation.client.aclose()


async def test_newly_known_secret_in_approved_description_is_blocked_before_post():
    secret = "synthetic-secret-configured-after-proposal"
    seen = []
    def respond(request):
        seen.append(request)
        return httpx.Response(404) if request.method == "GET" else httpx.Response(201, json=receipt(description=secret))
    creation, credentials = service(respond, proposal(description=secret))
    async def refresh_secret(identifier):
        creation.guard.known_secrets += (secret,)
        return SecretStr(TOKEN)
    credentials.resolve.side_effect = refresh_secret
    result = await creation.execute("proposal-1")
    assert result.status == "failed" and result.error_code == "SECRET_DETECTED"
    assert all(item.method == "GET" for item in seen)
    assert result.receipt is None
    await creation.client.aclose()


@pytest.mark.parametrize("existing", [True, False])
async def test_existing_repository_or_missing_creation_credential_never_posts(existing):
    seen = []
    def respond(request):
        seen.append(request)
        return httpx.Response(200, json=receipt())
    creation, _ = service(respond, token=TOKEN if existing else "")
    result = await creation.execute("proposal-1")
    assert result.status == ("conflict" if existing else "failed")
    assert all(item.method == "GET" for item in seen)
    assert len(seen) == int(existing)
    await creation.client.aclose()


@pytest.mark.parametrize("post_response", [
    httpx.Response(302, headers={"Location": "https://untrusted.invalid"}),
    httpx.Response(500, text=TOKEN),
    httpx.Response(201, json=receipt(private=False)),
    httpx.Response(201, json=receipt(id=True)),
    httpx.Response(201, json=receipt(description="different")),
    httpx.Response(201, json=receipt(full_name="other/new-repo")),
    httpx.Response(201, json=receipt(visibility="internal")),
    httpx.Response(201, json=receipt(created_at=0)),
    httpx.Response(201, content=b"x" * 1_000_001),
])
async def test_ambiguous_or_mismatching_post_result_never_claims_success_or_follows_redirect(post_response):
    seen = []
    def respond(request):
        seen.append(request)
        return httpx.Response(404) if request.method == "GET" else post_response
    creation, _ = service(respond)
    result = await creation.execute("proposal-1")
    assert result.status == "reconciliation_required" and result.receipt is None
    assert result.error_code == "REPOSITORY_EFFECT_UNKNOWN"
    assert len(seen) == 2 and all(item.url.host == "api.github.com" for item in seen)
    assert TOKEN not in result.model_dump_json()
    await creation.client.aclose()


async def test_lost_post_response_is_unknown_and_recovery_never_posts_again():
    posts = []
    def respond(request):
        if request.method == "POST":
            posts.append(request)
            raise httpx.ReadTimeout(TOKEN)
        return httpx.Response(404)
    creation, _ = service(respond)
    result = await creation.execute("proposal-1")
    assert result.status == "reconciliation_required" and len(posts) == 1
    creation._claim.return_value = (result, False)
    assert (await creation.execute("proposal-1")).status == "reconciliation_required"
    assert len(posts) == 1 and TOKEN not in result.model_dump_json()
    await creation.client.aclose()


@pytest.mark.parametrize("changes", [{"owner": "../owner"}, {"name": ".."}, {"visibility": "internal"}, {"description": "line\nbreak"}, {"idempotency_key": "x/y"}])
def test_material_proposal_fields_are_validated(changes):
    data = {"owner_type": "org", "owner": "fixture", "name": "new-repo", "idempotency_key": "fixture-request", **changes}
    with pytest.raises(ValidationError):
        RepoCreationRequest(**data)


def test_digest_binds_owner_name_type_visibility_and_description_but_not_replay_key():
    request = proposal().request
    for field, value in {"owner": "other", "owner_type": "user", "name": "other", "visibility": "public", "description": "Changed"}.items():
        assert request_digest(request.model_copy(update={field: value})) != request_digest(request)
    assert request_digest(request.model_copy(update={"idempotency_key": "different-key"})) == request_digest(request)
