import asyncio
import json
from contextlib import asynccontextmanager
from datetime import timedelta
from types import SimpleNamespace

import pytest
from langgraph.checkpoint.memory import InMemorySaver

from sabre.artifacts import ArtifactStore
from sabre.models import (
    AgentResult,
    Budget,
    DomainError,
    Project,
    SecurityException,
    SecurityFinding,
    Status,
    Task,
    WorkOrder,
    now,
)
from sabre.security import SecretGuard, is_blocking_finding
from sabre.workflows import Factory, validate_plan


class TestRepository:
    __test__ = False

    def __init__(self, work, project):
        self.current, self.project_value = work.model_copy(deep=True), project
        self.answer_value, self.control_value = None, None
        self.events_value = []

    async def work(self, work_id):
        return self.current.model_copy(deep=True)

    async def save(self, work):
        self.current = work.model_copy(deep=True)

    async def add_active_seconds(self, work_id, seconds):
        self.current.active_seconds_used += seconds

    async def project(self, project_id):
        return self.project_value

    async def control(self, work_id):
        return self.control_value

    async def event(self, work, kind, message):
        self.events_value.append((kind, message))

    async def usage(self, work_id):
        return {"calls": 0, "tokens": 0, "usd": 0}

    async def pending_answer(self, work_id):
        return self.answer_value

    async def pending_scope(self, work_id):
        return None

    async def clear_answer(self, work_id, question_id=None):
        if question_id is None or self.answer_value and self.answer_value["question_id"] == question_id:
            self.answer_value = None

    async def report_security(self, work):
        pass

    async def security_exceptions(self, work_id):
        return []

    @asynccontextmanager
    async def project_lock(self, project_id, *, execution_slot=True):
        yield True


class TestTeam:
    __test__ = False

    def __init__(self, question=False):
        self.question = question
        self.calls = []
        self.on_review = None

    async def run(self, role, work, project, instruction, memory=None, source_context=None, analysis_handoff=None, task_context=None, memory_tools=None):
        assert source_context.brief["project_id"] == work.project_id
        assert source_context.brief["role"] == role
        self.calls.append(role)
        if role == "analyst":
            return AgentResult(accepted=True, summary="Requisitos inspeccionados", questions=["¿Debe mantenerse la salida anterior?"] if self.question else [])
        if role == "architect":
            return AgentResult(accepted=True, summary="Comparación de Python y TS", decisions=["Python por requisitos del proyecto"])
        if role == "supervisor":
            return AgentResult(accepted=True, summary="Plan", tasks=[Task(title="Corregir comportamiento")])
        if role == "reviewer" and self.on_review:
            self.on_review()
        return AgentResult(accepted=True, summary=f"Resultado de {role}")


class TestExecutor:
    __test__ = False

    def __init__(self, failures=0):
        self.failures, self.gate_calls = failures, 0
        self.digest = "a" * 64
        self.prepared = False

    async def prepare(self, project, work_id):
        self.prepared = True

    async def prepare_dependencies(self, work_id):
        assert self.prepared

    async def cleanup(self, work_id):
        self.prepared = False

    async def snapshot(self, work_id):
        return {"digest": self.digest, "base_commit": "b" * 40, "files": [{"path": "app.py", "content": "print('ok')"}]}

    async def execute_gate(self, work_id, argv, digest):
        assert self.prepared
        assert digest == self.digest
        self.gate_calls += 1
        return SimpleNamespace(exit_code=1 if self.gate_calls <= self.failures else 0, output="Behavioral check result")

    async def security_version(self, work_id):
        return "rules-test"


class TestSecurity:
    __test__ = False

    def __init__(self, findings=None):
        self.findings = findings or []
        self.calls = []

    async def review(self, work_id, digest, baseline, exceptions=None, *, plan_revision=1):
        self.calls.append(digest)
        from sabre.security import SecurityReport, security_policy_digest
        return SecurityReport(snapshot_digest=digest, rules_version="rules-test", findings=self.findings,
                              blocked=any(is_blocking_finding(item) for item in self.findings), policy_digest=security_policy_digest(work_id, digest, "rules-test", baseline, exceptions or [], plan_revision=plan_revision))


class TestPublisher:
    __test__ = False

    def __init__(self):
        self.calls = []

    async def prepare_commit(self, work, project, snapshot):
        self.calls.append("commit")
        return "c" * 40

    async def publish(self, work, project, *, expected_base):
        assert expected_base == "b" * 40
        assert work.evidence and all(g.exit_code == 0 for g in work.evidence.gates)
        self.calls.append("publish")
        return {"branch": f"sabre/{work.id}", "pr_url": "https://github.com/example/project/pull/1"}

    async def validate_base(self, project, expected_commit):
        assert expected_commit == "b" * 40


class TestMemory:
    __test__ = False

    async def context_for_role(self, *args, **kwargs):
        return []

    def reader(self, *args):
        async def read_memory(**kwargs):
            return {}
        return read_memory

    def context_validator(self, *args):
        async def validate(references):
            return None
        return validate

    async def propose(self, item):
        return item


@pytest.fixture
def build_factory(tmp_path):
    def build(*, mode="patch", question=False, failures=0, findings=None, saver=None, prior=None):
        project = Project(name="Fixture", repository="https://github.com/example/project", profile="python", gate_commands=[["python", "-m", "unittest"]])
        work = WorkOrder(project_id=project.id, mode=mode, objective="Corregir el cálculo", acceptance=["Resultado correcto"], budget=Budget(max_cost_usd=1), idempotency_key="test-request-001")
        repo = prior or TestRepository(work, project)
        team, executor, security, publisher = TestTeam(question), TestExecutor(failures), TestSecurity(findings), TestPublisher()
        guard = SecretGuard()
        factory = Factory(repo, team, executor, security, publisher, ArtifactStore(tmp_path, guard), guard, TestMemory(), saver or InMemorySaver())
        return factory, repo, team, executor, security, publisher
    return build


@pytest.mark.parametrize("mode", ["patch", "maintain"])
async def test_patch_requires_gates_review_and_independent_security_before_publication(build_factory, mode):
    factory, repo, team, executor, security, publisher = build_factory(mode=mode)
    result = await factory.drive(repo.current.id)
    assert result.status == Status.COMPLETED
    assert executor.gate_calls == 1
    assert team.calls == ["analyst", "supervisor", "developer", "qa", "reviewer"]
    assert security.calls == ["a" * 64]
    assert publisher.calls == ["commit", "publish"]
    saved = await factory.graph.aget_state(factory.config(result.id))
    assert "files" not in saved.values["snapshot"]
    index = json.loads(factory.artifacts.get(saved.values["baseline_source_index"]))
    assert index["project_id"] == result.project_id and index["work_id"] == result.id
    assert index["files"][0]["path"] == "app.py" and "print('ok')" not in json.dumps(index)
    assert result.evidence.snapshot_digest == "a" * 64


@pytest.mark.parametrize("has_memory", [False, True])
async def test_task_context_is_separate_from_unchanged_instruction_and_legacy_checkpoint_state(build_factory, has_memory):
    factory, repo, team, executor, *_ = build_factory()
    work = repo.current
    dependency = Task(title="Prior task", status=Status.COMPLETED, result="Prior untrusted observation")
    current = Task(title="Current task", depends_on=[dependency.id])
    work.tasks = [dependency, current]
    if has_memory:
        async def selected_memory(*args, **kwargs):
            return [{"id": "memory-fixture", "content": "Historical observation", "content_digest": "a" * 64}]
        factory.memory.context_for_role = selected_memory
    captured = []
    run = team.run
    async def record(role, work, project, instruction, **kwargs):
        captured.append((instruction, kwargs))
        return await run(role, work, project, instruction, **kwargs)
    team.run = record
    await factory.role("developer", work, repo.project_value, "Task: Current task\nFeedback: ", task=current,
                       state={"order": work.model_dump(mode="json")})
    instruction, values = captured[0]
    assert instruction == "Task: Current task\nFeedback: "
    assert values["task_context"]["dependencies"][0]["task_id"] == dependency.id
    assert values["task_context"]["delta_available"] is False
    assert callable(values["memory_tools"]["validate_context"])
    assert callable(values["memory_tools"]["read_memory"]) if has_memory else "read_memory" not in values["memory_tools"]
    assert not (await factory.graph.aget_state(factory.config(work.id))).values


async def test_hitl_survives_new_factory_instance_with_same_checkpoint(build_factory):
    saver = InMemorySaver()
    factory, repo, *_ = build_factory(question=True, saver=saver)
    first = await factory.drive(repo.current.id)
    assert first.status == Status.WAITING_INPUT
    question = first.questions[0]
    repo.answer_value = {"question_id": question.id, "plan_revision": 1, "answer": "Sí, mantener compatibilidad"}
    recovered, _, _, executor, *_ = build_factory(prior=repo, saver=saver)
    executor.prepared = True
    second = await recovered.drive(first.id)
    assert second.status == Status.COMPLETED
    assert second.questions[0].answer == "Sí, mantener compatibilidad"


async def test_analysis_handoff_survives_hitl_restart_with_provenance_without_repeating_analysis(build_factory):
    saver = InMemorySaver()
    factory, repo, team, *_ = build_factory(question=True, saver=saver)
    original = team.run

    async def analyze_with_evidence(role, *args, **kwargs):
        result = await original(role, *args, **kwargs)
        if role == "analyst":
            result.decisions = ["app.py: conservar la salida existente"]
        return result

    team.run = analyze_with_evidence
    first = await factory.drive(repo.current.id)
    saved = await factory.graph.aget_state(factory.config(first.id))
    handoff = saved.values["analysis_handoff"]
    assert handoff["untrusted"] is True
    assert handoff["work_id"] == first.id and handoff["project_id"] == first.project_id
    assert handoff["plan_revision"] == first.plan_revision
    assert handoff["snapshot_digest"] == "a" * 64 and handoff["source_commit"] == "b" * 40
    assert handoff["decisions"] == ["app.py: conservar la salida existente"]
    question = first.questions[0]
    repo.answer_value = {"question_id": question.id, "plan_revision": 1, "answer": "Conservar compatibilidad"}
    recovered, _, next_team, executor, *_ = build_factory(prior=repo, saver=saver)
    executor.prepared = True
    original_next = next_team.run
    received = []

    async def capture(role, *args, **kwargs):
        if role == "supervisor":
            received.append(kwargs.get("analysis_handoff"))
        return await original_next(role, *args, **kwargs)

    next_team.run = capture
    completed = await recovered.drive(first.id)
    assert completed.status == Status.COMPLETED
    assert "analyst" not in next_team.calls
    assert received == [handoff]


@pytest.mark.parametrize(("field", "value"), [
    ("version", 2), ("work_id", "other-work"), ("project_id", "other-project"),
    ("plan_revision", 2), ("snapshot_digest", "c" * 64), ("source_commit", "d" * 40),
    ("summary", "x" * 9000), ("untrusted", False),
])
async def test_planner_does_not_receive_invalid_or_stale_analysis_handoff(build_factory, field, value):
    factory, repo, team, *_ = build_factory()
    state = await factory.analyze({"order": repo.current.model_dump(mode="json")})
    state["analysis_handoff"][field] = value
    original = team.run
    received = []

    async def capture(role, *args, **kwargs):
        received.append(kwargs.get("analysis_handoff"))
        return await original(role, *args, **kwargs)

    team.run = capture
    await factory.plan(state)
    assert received == [None]


@pytest.mark.parametrize("summary", ["á" * 3000, "\x01" * 2048], ids=["unicode", "json-escapes"])
async def test_analysis_handoff_is_bounded_and_secret_checked_before_compaction(build_factory, summary):
    factory, repo, team, *_ = build_factory()

    async def large_analysis(*args, **kwargs):
        return AgentResult(accepted=True, summary=summary, decisions=[f"Decision {i}: " + "é" * 1000 for i in range(20)])

    team.run = large_analysis
    state = await factory.analyze({"order": repo.current.model_dump(mode="json")})
    handoff = state["analysis_handoff"]
    assert len(json.dumps(handoff, ensure_ascii=False).encode()) <= 8192
    assert handoff["summary_truncated"] is True
    assert handoff["omitted_decisions"] > 0
    secret = "synthetic-private-analysis-value"
    factory.guard = SecretGuard([secret])

    async def secret_analysis(*args, **kwargs):
        return AgentResult(accepted=True, summary="Safe summary", decisions=["x" * 9000 + secret])

    team.run = secret_analysis
    with pytest.raises(DomainError) as caught:
        await factory.analyze({"order": repo.current.model_dump(mode="json")})
    assert caught.value.code == "SECRET_DETECTED"
    assert secret not in str(caught.value)


async def test_two_questions_keep_first_answer_and_offer_second_question(build_factory):
    factory, repo, team, *_ = build_factory(question=True)
    original = team.run

    async def two_questions(role, *args, **kwargs):
        result = await original(role, *args, **kwargs)
        if role == "analyst":
            result.questions.append("¿Qué resultado debe tener el caso vacío?")
        return result

    team.run = two_questions
    first = await factory.drive(repo.current.id)
    repo.answer_value = {"question_id": first.questions[0].id, "plan_revision": 1, "answer": "Mantener compatibilidad"}
    second = await factory.drive(first.id)
    assert second.status == Status.WAITING_INPUT
    assert second.questions[0].answer == "Mantener compatibilidad"
    pending = [q for q in second.questions if q.answer is None]
    assert len(pending) == 1
    assert "vacío" in pending[0].prompt
    repo.answer_value = {"question_id": pending[0].id, "plan_revision": 1, "answer": "Devolver cero"}
    completed = await factory.drive(first.id)
    assert completed.status == Status.COMPLETED
    assert all(q.answer for q in completed.questions)


async def test_answer_arriving_during_interrupt_publication_is_not_erased(build_factory):
    factory, repo, *_ = build_factory(question=True)
    save = repo.save

    async def answer_immediately(work):
        await save(work)
        if work.status == Status.WAITING_INPUT and repo.answer_value is None:
            q = next(q for q in work.questions if q.answer is None)
            repo.answer_value = {"question_id": q.id, "plan_revision": work.plan_revision, "answer": "Respuesta inmediata"}

    repo.save = answer_immediately
    await factory.drive(repo.current.id)
    assert repo.answer_value is not None
    completed = await factory.drive(repo.current.id)
    assert completed.status == Status.COMPLETED


async def test_create_stops_for_architecture_approval(build_factory):
    factory, repo, team, _, _, publisher = build_factory(mode="create")
    result = await factory.drive(repo.current.id)
    assert result.status == Status.WAITING_INPUT
    assert result.questions[-1].kind == "architecture"
    assert "developer" not in team.calls
    assert publisher.calls == []
    question = result.questions[-1]
    repo.answer_value = {"question_id": question.id, "plan_revision": question.plan_revision, "answer": "Aprobar"}
    completed = await factory.drive(result.id)
    assert completed.status == Status.COMPLETED


async def test_failed_gates_repair_at_most_twice_then_block(build_factory):
    factory, repo, team, executor, _, publisher = build_factory(failures=10)
    result = await factory.drive(repo.current.id)
    assert result.status == Status.BLOCKED
    assert result.error_code == "REPAIR_LIMIT"
    assert executor.gate_calls == 3
    assert team.calls.count("developer") == 3
    assert publisher.calls == []


async def test_scanner_failure_blocks_without_model_repair(build_factory):
    finding = SecurityFinding(fingerprint="error", scanner="trivy", category="scanner_error", severity="high", title="No disponible")
    factory, repo, team, _, _, publisher = build_factory(findings=[finding])
    result = await factory.drive(repo.current.id)
    assert result.error_code == "SECURITY_INCOMPLETE"
    assert result.status == Status.BLOCKED
    assert team.calls.count("developer") == 1
    assert publisher.calls == []


async def test_changed_snapshot_invalidates_evidence(build_factory):
    factory, repo, team, executor, _, publisher = build_factory()
    team.on_review = lambda: setattr(executor, "digest", "d" * 64)
    result = await factory.drive(repo.current.id)
    assert result.status == Status.BLOCKED
    assert result.error_code == "STALE_EVIDENCE"
    assert publisher.calls == []


async def test_pause_and_cancel_do_not_claim_success(build_factory):
    factory, repo, team, *_ = build_factory()
    repo.control_value = "pause"
    paused = await factory.drive(repo.current.id)
    assert paused.status == Status.PAUSED
    assert team.calls == []
    repo.control_value = "cancel"
    cancelled = await factory.drive(repo.current.id)
    assert cancelled.status == Status.CANCELLED


def test_task_dependency_cycle_is_rejected():
    with pytest.raises(DomainError, match="circular"):
        validate_plan([Task(id="a", title="A", depends_on=["b"]), Task(id="b", title="B", depends_on=["a"])])


async def test_developer_can_request_hitl_before_task_is_completed(build_factory):
    factory, repo, team, _, _, publisher = build_factory()
    original = team.run

    async def ask_during_development(role, work, *args, **kwargs):
        if role == "developer" and not any(q.answer and "formato" in q.answer for q in work.questions):
            return AgentResult(accepted=True, summary="Falta una decisión", questions=["¿Qué formato debe tener la salida?"])
        return await original(role, work, *args, **kwargs)

    team.run = ask_during_development
    waiting = await factory.drive(repo.current.id)
    assert waiting.status == Status.WAITING_INPUT
    assert waiting.tasks[0].status != Status.COMPLETED
    assert publisher.calls == []
    q = next(q for q in waiting.questions if q.answer is None)
    repo.answer_value = {"question_id": q.id, "plan_revision": 1, "answer": "Usa formato JSON"}
    assert (await factory.drive(waiting.id)).status == Status.COMPLETED


@pytest.mark.parametrize("role", ["qa", "reviewer"])
async def test_independent_specialist_questions_pause_then_resume(build_factory, role):
    factory, repo, team, _, _, publisher = build_factory()
    original = team.run

    async def ask(specialist, work, *args, **kwargs):
        if specialist == role and not any(q.answer for q in work.questions):
            return AgentResult(accepted=True, summary="Falta un criterio", questions=["¿Cómo comprobamos el caso vacío?"])
        return await original(specialist, work, *args, **kwargs)

    team.run = ask
    waiting = await factory.drive(repo.current.id)
    assert waiting.status == Status.WAITING_INPUT
    assert publisher.calls == []
    question = next(q for q in waiting.questions if q.answer is None)
    repo.answer_value = {"question_id": question.id, "plan_revision": 1, "answer": "Debe devolver cero"}
    assert (await factory.drive(waiting.id)).status == Status.COMPLETED


async def test_active_time_bounds_the_whole_segment_including_tool_waits(build_factory):
    factory, repo, team, executor, _, publisher = build_factory()
    repo.current.budget.active_seconds = 60
    repo.current.active_seconds_used = 59.97

    async def stall(work_id):
        await asyncio.sleep(0.2)

    executor.prepare_dependencies = stall
    result = await factory.drive(repo.current.id)
    assert result.status == Status.BLOCKED
    assert result.error_code == "TIME_BUDGET"
    assert repo.current.active_seconds_used >= 60
    assert team.calls == []
    assert publisher.calls == []


async def test_cli_progress_resume_reads_current_budget_without_rewriting_old_checkpoint(build_factory):
    factory, repo, team, _, _, publisher = build_factory(question=True)
    waiting = await factory.drive(repo.current.id)
    assert waiting.status == Status.WAITING_INPUT
    saved = await factory.graph.aget_state(factory.config(waiting.id))
    assert saved.values["order"]["budget"]["active_seconds"] == 3600
    question = next(q for q in waiting.questions if q.answer is None)
    repo.current.budget = Budget(max_calls=None, max_tokens=None, active_seconds=None)
    repo.current.active_seconds_used = 100_000
    repo.answer_value = {"question_id": question.id, "plan_revision": 1, "answer": "Mantener la salida"}
    result = await factory.drive(waiting.id)
    assert result.status == Status.COMPLETED
    assert result.budget == repo.current.budget == Budget(max_calls=None, max_tokens=None, active_seconds=None)
    assert repo.current.active_seconds_used > 100_000
    assert team.calls.count("analyst") == 1
    assert publisher.calls == ["commit", "publish"]


@pytest.mark.parametrize("code", ["AGENT_TIMEOUT", "AGENT_STEP_LIMIT"])
async def test_agent_operational_limit_blocks_without_publication_or_automatic_retry(build_factory, code):
    factory, repo, team, _, _, publisher = build_factory()
    repo.current.budget = Budget(max_calls=None, max_tokens=None, active_seconds=None)
    roles = []

    async def stop(role, *args, **kwargs):
        roles.append(role)
        raise DomainError(code, "Límite operativo de la etapa")

    team.run = stop
    result = await factory.drive(repo.current.id)
    assert result.status == Status.BLOCKED and result.error_code == code
    assert roles == ["analyst"] and publisher.calls == []
    assert repo.current.active_seconds_used > 0


@pytest.mark.parametrize("progress_limits", [False, True])
async def test_recovery_finishes_memory_and_cleanup_after_delivery_checkpoint(build_factory, monkeypatch, progress_limits):
    factory, repo, _, executor, _, publisher = build_factory()
    if progress_limits:
        repo.current.budget = Budget(max_calls=None, max_tokens=None, active_seconds=None)
    fail_once = True
    remembered = []

    async def interrupted_memory(item):
        nonlocal fail_once
        if fail_once:
            fail_once = False
            first_run.cancel()
            await asyncio.Event().wait()
        remembered.append(item)

    factory.memory.propose = interrupted_memory
    first_run = asyncio.create_task(factory.drive(repo.current.id))
    with pytest.raises(asyncio.CancelledError):
        await first_run
    assert repo.current.status == Status.COMPLETED
    assert executor.prepared
    assert (await factory.graph.aget_state(factory.config(repo.current.id))).next == ("remember",)
    prior_seconds = (repo.current.budget.active_seconds or 3600) + 1
    repo.current.active_seconds_used = prior_seconds
    timeouts = []
    original_timeout = asyncio.timeout

    def record_timeout(delay):
        timeouts.append(delay)
        return original_timeout(delay)

    monkeypatch.setattr(asyncio, "timeout", record_timeout)
    assert (await factory.drive(repo.current.id)).status == Status.COMPLETED
    assert timeouts[0] == 60
    assert len(remembered) == 1
    assert not executor.prepared
    assert publisher.calls == ["commit", "publish"]
    assert repo.current.active_seconds_used >= prior_seconds


async def test_supervisor_question_is_answered_before_tasks_begin(build_factory):
    factory, repo, team, _, _, publisher = build_factory()
    original = team.run

    async def ask(role, work, *args, **kwargs):
        if role == "supervisor" and not any(q.answer for q in work.questions):
            return AgentResult(summary="Falta prioridad", accepted=False, questions=["¿Qué compatibilidad priorizamos?"])
        return await original(role, work, *args, **kwargs)

    team.run = ask
    waiting = await factory.drive(repo.current.id)
    assert waiting.status == Status.WAITING_INPUT
    assert waiting.tasks == []
    assert "developer" not in team.calls
    assert publisher.calls == []
    question = next(q for q in waiting.questions if q.answer is None)
    repo.answer_value = {"question_id": question.id, "plan_revision": 1, "answer": "Mantener la API anterior"}
    assert (await factory.drive(waiting.id)).status == Status.COMPLETED


async def test_rejected_plan_does_not_fabricate_a_task_or_start_implementation(build_factory):
    factory, repo, team, _, _, publisher = build_factory()
    original = team.run

    async def reject(role, *args, **kwargs):
        return AgentResult(summary="No hay solución con estos permisos", accepted=False) if role == "supervisor" else await original(role, *args, **kwargs)

    team.run = reject
    result = await factory.drive(repo.current.id)
    assert result.status == Status.BLOCKED
    assert result.error_code == "PLAN_REJECTED"
    assert "developer" not in team.calls
    assert publisher.calls == []


async def test_revocation_after_review_blocks_delivery_and_schedules_a_fresh_security_review(build_factory):
    factory, repo, _, _, security, publisher = build_factory()
    exception = SecurityException(work_id=repo.current.id, project_id=repo.current.project_id,
        fingerprint="known-risk", justification="Owner accepts risk for the isolated fixture", expires_at=now() + timedelta(days=1),
        snapshot_digest="a" * 64, rules_version="rules-test", plan_revision=1)
    security.findings = [SecurityFinding(fingerprint=exception.fingerprint, scanner="trivy", category="vulnerability",
        severity="high", title="Known fixture vulnerability", exception_id=exception.id)]

    async def exceptions(work_id):
        return [exception]

    original = publisher.prepare_commit

    async def revoke(*args):
        commit = await original(*args)
        exception.revoked_at = now()
        return commit

    repo.security_exceptions, publisher.prepare_commit = exceptions, revoke
    result = await factory.drive(repo.current.id)
    assert result.status == Status.BLOCKED
    assert result.error_code == "SECURITY_POLICY_CHANGED"
    assert result.evidence is None
    assert publisher.calls == ["commit"]
    assert (await factory.graph.aget_state(factory.config(result.id))).next == ("security_check",)


@pytest.mark.parametrize("command", ["pause", "resume", "cancel"])
async def test_watch_report_cannot_be_resumed_as_a_development_order(build_factory, command):
    from sabre.service import FactoryService
    factory, repo, *_ = build_factory()
    repo.current.phase, repo.current.status = "security_watch", Status.BLOCKED
    service = FactoryService(repo, factory, factory.memory, None, factory.guard, None)
    with pytest.raises(DomainError) as error:
        await service.control(repo.current.id, command)
    assert error.value.code == "WATCH_REPORT"
