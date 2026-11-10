from datetime import UTC, datetime, timedelta

import httpx
import pytest

from sabre.models import (
    Budget,
    DeliveryEvidence,
    DomainError,
    GateResult,
    Project,
    SecurityException,
    SecurityFinding,
    WorkOrder,
)
from sabre.publisher import GitHubPublisher
from sabre.security import security_policy_digest


async def test_exception_expiring_during_github_reads_blocks_new_publication(monkeypatch):
    moment = datetime(2026, 11, 5, 12, tzinfo=UTC)
    monkeypatch.setattr("sabre.security.now", lambda: moment)
    project = Project(name="Fixture", repository="https://github.com/example/project", profile="python", gate_commands=[["python", "-m", "unittest"]])
    work = WorkOrder(project_id=project.id, mode="patch", objective="Correct the fixture behavior", acceptance=["Correct output"], budget=Budget(max_cost_usd=1), idempotency_key="publication-fixture")
    approved = SecurityException(work_id=work.id, project_id=project.id, fingerprint="issue", justification="Owner accepts the short remediation delay",
        expires_at=moment + timedelta(seconds=30), approved_at=moment - timedelta(seconds=1), snapshot_digest="a" * 64, rules_version="rules-test", plan_revision=1)
    work.evidence = DeliveryEvidence(commit="c" * 40, snapshot_digest="a" * 64, profile_digest="d" * 64, rules_version="rules-test",
        gates=[GateResult(command=project.gate_commands[0], exit_code=0, output_digest="e" * 64, snapshot_digest="a" * 64)],
        findings=[SecurityFinding(fingerprint="issue", scanner="test", category="code", severity="high", title="Issue", exception_id=approved.id)], review="Reviewed",
        security_policy_digest=security_policy_digest(work.id, "a" * 64, "rules-test", [], [approved]), security_exception_ids=[approved.id])
    writes = []

    class Repository:
        async def get_effect(self, key):
            return None

        async def begin_effect(self, key, request):
            return {"state": "pending"}

        async def security_exceptions(self, work_id):
            return [approved]

        async def work(self, work_id):
            return work

        async def project(self, project_id):
            return project

        async def finish_effect(self, key, result):
            pass

    async def handle(request):
        nonlocal moment
        if request.method == "POST":
            writes.append(request.url.path)
            return httpx.Response(200, json={"html_url": "https://github.com/example/project/pull/1"})
        if request.url.path.endswith("/pulls"):
            moment = approved.expires_at + timedelta(seconds=1)
            return httpx.Response(200, json=[])
        if request.url.path.endswith("/git/ref/heads/main"):
            return httpx.Response(200, json={"object": {"sha": "b" * 40}})
        return httpx.Response(404)

    async with httpx.AsyncClient(base_url="https://api.github.com", transport=httpx.MockTransport(handle)) as client:
        publisher = GitHubPublisher(Repository(), "synthetic-github-token", client)
        with pytest.raises(DomainError) as error:
            await publisher.publish(work, project, expected_base="b" * 40)
    assert error.value.code == "SECURITY_POLICY_CHANGED"
    assert writes == []
