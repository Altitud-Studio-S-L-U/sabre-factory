"""Provisioning replay and continuation use real transactions with synthetic GitHub."""

import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock

import httpx
import pytest

from integration.test_postgres import repository as postgres_repository
from sabre.create_flow import CreateFlowLaunch, continue_create, launch_create
from sabre.flow_contracts import ResolvedFlow
from sabre.models import DomainError, new_id
from sabre.repo_creation import RepoCreationService
from sabre.security import SecretGuard

repository = postgres_repository


async def test_authorized_launch_pins_models_and_replays_external_and_admission_effects_once(repository, monkeypatch):
    repo, created = repository
    key = new_id()
    queued, admitted, posts = [], [], []
    credentials = SimpleNamespace(resolve=AsyncMock(return_value=SimpleNamespace(get_secret_value=lambda: "synthetic-create-token")),
        revision=(), ensure_enabled=AsyncMock(), assert_current=AsyncMock())
    async def enqueue(conn, proposal_id):
        queued.append(proposal_id)
    async def enqueue_work(conn, work_id):
        admitted.append(work_id)
    async def remote(request):
        if request.method == "GET":
            return httpx.Response(404)
        posts.append(request.read())
        return httpx.Response(201, json={"id": 234, "full_name": f"example/{key}", "private": True,
            "created_at": "2026-11-10T10:00:00Z", "default_branch": "trunk", "description": ""})
    async with httpx.AsyncClient(transport=httpx.MockTransport(remote)) as client:
        proposals = RepoCreationService(repo, credentials, SecretGuard([]), enqueue=enqueue, client=client)
        resolved = ResolvedFlow(model_revision=4, phases={}, configuration_digest="a" * 64)
        resolver = AsyncMock(return_value=resolved)
        monkeypatch.setattr("sabre.create_flow.resolve_flow", resolver)
        service = SimpleNamespace(repository=repo, guard=SecretGuard([]), repository_proposals=lambda: proposals,
            queue=SimpleNamespace(model_configuration=object(), credentials=credentials), preflight=AsyncMock(), enqueue=enqueue_work)
        request = CreateFlowLaunch.model_validate({"version": 1, "authorize_repository_creation": True,
            "repository": {"owner_type": "org", "owner": "example", "name": key, "initialize": True, "idempotency_key": key},
            "profile": "node", "gate_commands": [["node", "--test"]], "objective": "Build a synthetic project",
            "acceptance": ["Registered checks pass"], "budget": {}})
        try:
            proposal = await launch_create(service, request)
            assert proposal.status == "approved" and queued == [proposal.id]
            resolver.side_effect = RuntimeError("Global configuration is now different")
            assert (await launch_create(service, request)).id == proposal.id
            with pytest.raises(DomainError, match="different details"):
                await launch_create(service, request.model_copy(update={"objective": "Changed scope"}))
            outcomes = await asyncio.gather(proposals.execute(proposal.id), proposals.execute(proposal.id))
            receipt = next(item for item in outcomes if item.status == "created")
            await continue_create(service, receipt)
            await continue_create(service, receipt)
            work = await repo.work(admitted[0])
            created.append(work.project_id)
            assert len(posts) == len(admitted) == 1
            assert b'"auto_init":true' in posts[0]
            assert work.resolved_flow.model_revision == 4
            assert (await repo.project(work.project_id)).default_branch == "trunk"
        finally:
            async with repo.connection() as conn:
                await conn.execute("DELETE FROM repository_flow_launches WHERE proposal_id IN (SELECT id FROM repository_proposals WHERE request_key=%s)", (key,))
                await conn.execute("DELETE FROM repository_proposals WHERE request_key=%s", (key,))


@pytest.mark.parametrize("permission", [False, 1, "true", None])
def test_creation_permission_is_not_coerced(permission):
    from pydantic import ValidationError
    with pytest.raises(ValidationError):
        CreateFlowLaunch.model_validate({"version": 1, "authorize_repository_creation": permission,
            "repository": {"owner_type": "org", "owner": "example", "name": "demo", "initialize": True, "idempotency_key": "synthetic-key"},
            "profile": "node", "gate_commands": [["node", "--test"]], "objective": "Synthetic project",
            "acceptance": ["Tests pass"], "budget": {}})
