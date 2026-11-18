"""Factory stages hand each role its task evidence and verify before model QA."""

import json

from sabre.models import GateResult, Status, Task
from sabre.security import SecretGuard
from sabre.workflows import (
    MAX_GATE_EVIDENCE_BYTES,
    MAX_REPAIR_FEEDBACK_BYTES,
    MAX_TASK_PACKAGE_BYTES,
    gate_evidence,
    repair_feedback,
    task_context,
    task_package,
)
from tests.test_factory_workflow import build_factory  # noqa: F401 - pytest fixture
from tests.test_memory_budget import fixture_work


def snapshot():
    return {"base_commit": "a" * 40, "digest": "b" * 64, "files": [{"path": "pricing.py", "content": "x", "encoding": "utf-8"}]}

def test_developer_context_carries_the_planned_scope_acceptance_and_checks():
    _, work = fixture_work()
    task = Task(title="Round totals", scope=["pricing.py"], acceptance=["Half a cent rounds up"],
                verification_commands=[["python", "-m", "unittest"]])
    work.tasks = [task]
    value = task_context(work, snapshot(), "developer", SecretGuard(), task=task)
    assert value["task"] == {"task_id": task.id, "title": "Round totals", "specialty": "general", "scope": ["pricing.py"],
                             "acceptance": ["Half a cent rounds up"], "verification_commands": [["python", "-m", "unittest"]],
                             "omitted_items": 0}
    assert "approved plan for this task" in value["usage"]
    assert "task" not in task_context(work, snapshot(), "reviewer", SecretGuard())

def test_task_package_is_bounded_and_counts_omissions():
    task = Task(title="Large", scope=[f"src/{index:03}/" + "p" * 280 for index in range(30)],
                acceptance=["criterion " + "c" * 480 for _ in range(30)], verification_commands=[["npm", "test"]])
    value = task_package(task)
    assert len(json.dumps(value, ensure_ascii=False).encode()) <= MAX_TASK_PACKAGE_BYTES
    assert value["omitted_items"] > 0 and value["verification_commands"] == [["npm", "test"]]

def test_completed_task_acceptance_reaches_qa_and_review():
    _, work = fixture_work()
    work.tasks = [Task(title="Done", status=Status.COMPLETED, result="ok", acceptance=["Rejects 120%"])]
    value = task_context(work, snapshot(), "qa", SecretGuard())
    assert value["dependencies"][0]["acceptance"] == ["Rejects 120%"]

def test_gate_evidence_is_bounded_and_keeps_the_tail():
    results = [GateResult(command=["pytest"], exit_code=1, output_digest="d" * 64, snapshot_digest="b" * 64)] * 3
    outputs = ["noise\n" * 5000 + "FAILED test_rounding - assert 0.12 == 0.13"] * 3
    value = gate_evidence(results, outputs, "b" * 64)
    assert value["kind"] == "deterministic_gate_results"
    assert len(json.dumps(value).encode()) <= MAX_GATE_EVIDENCE_BYTES
    assert all(item["output_tail"].endswith("0.12 == 0.13") and item["output_truncated"] for item in value["results"])

async def test_gates_run_before_model_qa_and_reach_it_as_evidence(build_factory):  # noqa: F811
    factory, repo, team, executor, *_ = build_factory()
    seen = []
    run = team.run

    async def record(role, work, project, instruction, **kwargs):
        if role == "qa":
            seen.append((executor.gate_calls, kwargs["task_context"].get("evidence")))
        return await run(role, work, project, instruction, **kwargs)

    team.run = record
    result = await factory.drive(repo.current.id)
    assert result.status == Status.COMPLETED
    gates_before_qa, evidence = seen[0]
    assert gates_before_qa == 1 and evidence["kind"] == "deterministic_gate_results"
    assert evidence["results"][0]["exit_code"] == 0 and evidence["results"][0]["output_tail"] == "Behavioral check result"

async def test_failed_gate_skips_model_qa_and_feeds_a_bounded_repair(build_factory):  # noqa: F811
    factory, repo, team, executor, *_ = build_factory(failures=1)
    feedback = []
    run = team.run

    async def record(role, work, project, instruction, **kwargs):
        if role == "developer" and "Feedback: {" in instruction:
            feedback.append(json.loads(instruction.split("Feedback: ", 1)[1]))
        return await run(role, work, project, instruction, **kwargs)

    team.run = record
    result = await factory.drive(repo.current.id)
    assert result.status == Status.COMPLETED
    assert team.calls.count("qa") == 1 and team.calls.count("developer") == 2
    assert feedback[0]["kind"] == "repair_feedback"
    assert feedback[0]["failed_checks"][0]["exit_code"] == 1
    assert feedback[0]["failed_checks"][0]["output_tail"] == "Behavioral check result"
    assert "deterministic gates failed" in feedback[0]["qa"]

async def test_review_receives_the_measured_gate_evidence(build_factory):  # noqa: F811
    factory, repo, team, executor, *_ = build_factory()
    seen = []
    run = team.run

    async def record(role, work, project, instruction, **kwargs):
        if role == "reviewer":
            seen.append((executor.gate_calls, kwargs["task_context"].get("evidence")))
        return await run(role, work, project, instruction, **kwargs)

    team.run = record
    result = await factory.drive(repo.current.id)
    assert result.status == Status.COMPLETED
    gate_calls, evidence = seen[0]
    assert gate_calls == 1
    assert evidence["kind"] == "deterministic_gate_results"
    gate = evidence["results"][0]
    assert gate["exit_code"] == 0 and gate["output_tail"] == "Behavioral check result"
    assert factory.artifacts.get(gate["output_digest"]).decode() == gate["output_tail"]
    assert result.evidence is not None and result.evidence.snapshot_digest == evidence["snapshot_digest"]


def test_repair_feedback_lists_only_blocking_findings_and_stays_bounded():
    findings = [{"fingerprint": f"f{index}", "scanner": "semgrep", "category": "code", "severity": "high", "title": "t" * 400,
                 "path": "app.py", "line": index + 1, "remediation": "r" * 3000, "baseline": False, "exception_id": None,
                 "reference": None} for index in range(60)]
    findings.append({**findings[0], "fingerprint": "low", "severity": "low"})
    state = {"gate_evidence": {"results": [{"command": ["pytest"], "exit_code": 1, "output_tail": "E" * 3000}]},
             "qa_review": "q" * 5000, "review": "v" * 5000}
    value = json.loads(repair_feedback(state, ["pytest"], {"findings": findings}))
    assert len(json.dumps(value, ensure_ascii=False).encode()) <= MAX_REPAIR_FEEDBACK_BYTES
    assert all(item["fingerprint"] != "low" for item in value["blocking_security_findings"])
    assert all("remediation" not in item for item in value["blocking_security_findings"])
    assert value["omitted_security_findings"] >= 40
    assert value["failed_checks"][0]["exit_code"] == 1
