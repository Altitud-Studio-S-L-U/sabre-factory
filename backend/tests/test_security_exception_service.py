from contextlib import asynccontextmanager
from datetime import timedelta

import pytest
from langgraph.checkpoint.memory import InMemorySaver

from sabre.artifacts import ArtifactStore
from sabre.models import (
    Budget,
    DomainError,
    Project,
    SecurityException,
    SecurityExceptionCreate,
    Status,
    WorkOrder,
    now,
)
from sabre.security import SecretGuard, SecurityService
from sabre.service import FactoryService
from sabre.workflows import Factory
from tests.test_factory_workflow import TestExecutor, TestMemory, TestPublisher, TestRepository, TestTeam
from tests.test_security import Scanner, finding


class ExceptionRepository(TestRepository):
    def __init__(self, work, project):
        super().__init__(work, project)
        self.exceptions = []

    async def security_exceptions(self, work_id):
        return self.exceptions

    async def create_security_exception(self, work_id, request):
        approved = SecurityException(**request.model_dump(), work_id=work_id, project_id=self.current.project_id)
        self.exceptions.append(approved)
        return approved

    async def revoke_security_exception(self, work_id, exception_id):
        approved = next(item for item in self.exceptions if item.id == exception_id)
        approved.revoked_at = now()
        return approved


async def test_owner_approval_rescans_the_same_snapshot_before_resuming_delivery(tmp_path):
    project = Project(name="Fixture", repository="https://github.com/example/project", profile="python", gate_commands=[["python", "-m", "unittest"]])
    work = WorkOrder(project_id=project.id, mode="patch", objective="Correct the fixture behavior", acceptance=["Correct output"], budget=Budget(max_cost_usd=1), idempotency_key="exception-fixture")
    repository, executor, publisher = ExceptionRepository(work, project), TestExecutor(), TestPublisher()

    class VersionedScanner(Scanner):
        async def security_version(self, work_id):
            return "rules-test"

    scanner = VersionedScanner([finding()])
    guard = SecretGuard()
    factory = Factory(repository, TestTeam(), executor, SecurityService(scanner), publisher, ArtifactStore(tmp_path), guard, TestMemory(), InMemorySaver())
    blocked = await factory.drive(work.id)
    assert blocked.status == Status.BLOCKED and blocked.error_code == "REPAIR_LIMIT"
    before = len(scanner.calls)
    service = FactoryService(repository, factory, TestMemory(), None, guard, None)
    request = SecurityExceptionCreate(fingerprint="existing", justification="Owner accepts the bounded remediation delay",
        expires_at=now() + timedelta(days=1), snapshot_digest=blocked.security_snapshot_digest,
        rules_version=blocked.security_rules_version, plan_revision=blocked.plan_revision)
    approved = await service.approve_security_exception(work.id, request)
    checkpoint = await factory.graph.aget_state(factory.config(work.id))
    assert checkpoint.next == ("security_check",)
    assert (await repository.work(work.id)).evidence is None
    delivered = await factory.drive(work.id)
    assert delivered.status == Status.COMPLETED
    assert len(scanner.calls) == before + 1
    assert delivered.evidence.security_exception_ids == [approved.id]
    assert delivered.evidence.security_policy_digest
    assert publisher.calls == ["commit", "publish"]


async def test_revocation_cannot_race_an_active_project_writer():
    project = Project(name="Fixture", repository="https://github.com/example/project", profile="python", gate_commands=[["python", "-m", "unittest"]])
    work = WorkOrder(project_id=project.id, mode="patch", objective="Correct the fixture behavior", acceptance=["Correct output"], budget=Budget(max_cost_usd=1), idempotency_key="revoke-fixture")
    work.status = Status.PAUSED
    repository = ExceptionRepository(work, project)
    approved = SecurityException(work_id=work.id, project_id=project.id, fingerprint="issue", justification="Owner accepts a temporary remediation delay",
        expires_at=now() + timedelta(days=1), snapshot_digest="a" * 64, rules_version="rules-test", plan_revision=1)
    repository.exceptions.append(approved)

    @asynccontextmanager
    async def busy(project_id, *, execution_slot=True):
        yield False

    repository.project_lock = busy
    service = FactoryService(repository, None, None, None, SecretGuard(), None)
    with pytest.raises(DomainError) as error:
        await service.revoke_security_exception(work.id, approved.id)
    assert error.value.code == "PROJECT_BUSY"
    assert approved.revoked_at is None
