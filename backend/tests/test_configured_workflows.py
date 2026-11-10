

from sabre.flow_contracts import ResolvedFlow
from sabre.models import AgentResult, Status, Task
from tests.test_factory_workflow import build_factory as factory_fixture

build_factory = factory_fixture


def configure(repo, team):
    repo.current.resolved_flow = ResolvedFlow(model_revision=1, phases={}, configuration_digest="a" * 64)
    original = team.run

    async def run(role, work, project, instruction, **kwargs):
        if role == "supervisor":
            team.calls.append(role)
            return AgentResult(accepted=True, summary="Bounded implementation plan", tasks=[Task(
                title="Fix the regression", scope=["app.py"], acceptance=["The approved check passes"],
                verification_commands=project.gate_commands)])
        return await original(role, work, project, instruction, **kwargs)
    team.run = run


async def test_patch_records_failure_before_fix_and_success_before_publication(build_factory):
    factory, repo, team, executor, _, publisher = build_factory(failures=1)
    configure(repo, team)
    result = await factory.drive(repo.current.id)
    assert result.status == Status.COMPLETED
    saved = await factory.graph.aget_state(factory.config(result.id))
    assert saved.values["baseline_checks"][0]["exit_code"] == 1
    assert saved.values["gates"][0]["exit_code"] == 0
    assert executor.gate_calls == 2
    assert publisher.calls == ["commit", "publish"]


async def test_create_with_launch_permission_does_not_require_routine_approval(build_factory):
    factory, repo, team, _, _, publisher = build_factory(mode="create")
    configure(repo, team)
    result = await factory.drive(repo.current.id)
    assert result.status == Status.COMPLETED
    assert not result.questions
    assert "architect" in team.calls
    assert publisher.calls == ["commit", "publish"]


async def test_audit_skips_implementation_and_never_publishes(build_factory):
    factory, repo, team, executor, _, publisher = build_factory(mode="audit")
    configure(repo, team)
    result = await factory.drive(repo.current.id)
    assert result.status == Status.COMPLETED
    assert team.calls == ["analyst", "qa", "reviewer"]
    assert executor.gate_calls == 1 and not publisher.calls


async def test_audit_rejects_modified_source(build_factory):
    factory, repo, team, executor, _, publisher = build_factory(mode="audit")
    configure(repo, team)
    team.on_review = lambda: setattr(executor, "digest", "c" * 64)
    result = await factory.drive(repo.current.id)
    assert result.status == Status.BLOCKED
    assert result.error_code == "AUDIT_SOURCE_CHANGED"
    assert not publisher.calls


async def test_no_repair_permission_stops_after_first_failed_verification(build_factory):
    factory, repo, team, executor, _, publisher = build_factory(failures=10)
    configure(repo, team)
    repo.current.flow_config.repair_cycles = 0
    result = await factory.drive(repo.current.id)
    assert result.status == Status.BLOCKED and result.error_code == "REPAIR_LIMIT"
    assert executor.gate_calls == 2  # Baseline and one independent verification.
    assert team.calls.count("developer") == 1 and not publisher.calls


async def test_denied_publication_never_reaches_publisher(build_factory):
    factory, repo, team, _, _, publisher = build_factory()
    configure(repo, team)
    repo.current.flow_config.permissions.draft_pull_request = False
    result = await factory.drive(repo.current.id)
    assert result.status == Status.BLOCKED and result.error_code == "DELIVERY_NOT_AUTHORIZED"
    assert not publisher.calls
