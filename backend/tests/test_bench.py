import json

import pytest

from sabre.bench import SUITE, BenchTask, has_entry, load_tasks, main, run_suite
from sabre.models import DomainError


def test_suite_tasks_are_valid_and_reference_existing_fixtures():
    tasks = load_tasks(SUITE)
    assert {task.id for task in tasks} >= {"patch-rounding", "patch-discount", "audit-pricing"}
    for task in tasks:
        assert (SUITE / "repos" / task.repo).is_dir()
        for source in task.grader.files.values():
            assert (SUITE / source).is_file()
        assert all(command in task.gate_commands for command in task.gate_commands)


def test_unknown_task_is_rejected():
    with pytest.raises(DomainError) as error:
        load_tasks(SUITE, ["missing-task"])
    assert error.value.code == "BENCH_TASK_UNKNOWN"


async def test_reference_policy_completes_every_task_through_the_real_factory_and_reports_measurements():
    report = await run_suite()
    assert report["driver"] == "reference_policy" and report["token_basis"] == "estimated_utf8_bytes_div_4"
    assert report["summary"]["failed"] == 0, json.dumps(report["tasks"], indent=2)
    for result in report["tasks"]:
        assert result["status"] == "completed" and result["grade"]["verdict"] == "pass"
        assert result["calls"]["total"] >= 4 and result["tokens"]["reserved_total"] > result["tokens"]["estimated_total"] > 0
        assert result["context"]["sent_bytes_max"] > 0 and result["tools"]["output_bytes"] > 0
        assert set(result["probes"]) == {"developer_receives_task_acceptance", "developer_receives_task_scope",
                                         "deterministic_gates_before_model_qa", "qa_receives_gate_results"}
        applicable = result["mode"] != "audit"
        assert all(isinstance(value, bool) if applicable or not name.startswith("developer_") else value is None
                   for name, value in result["probes"].items())
        assert set(result["budget_feasibility"]) == {"reservation_at_context_limit", "budget_max_tokens", "fits"}
        # Loop-correctness properties: the planned task reaches the developer, deterministic gates
        # run before model QA and reach it, and one call at the context ceiling fits the budget.
        assert result["probes"]["deterministic_gates_before_model_qa"] and result["probes"]["qa_receives_gate_results"]
        assert applicable is False or (result["probes"]["developer_receives_task_acceptance"] and result["probes"]["developer_receives_task_scope"])
        assert result["budget_feasibility"]["fits"]
        assert result["calls"]["by_role"]["qa"] == 1
    audit = next(result for result in report["tasks"] if result["mode"] == "audit")
    assert audit["grade"]["source_unchanged"] and "developer" not in audit["calls"]["by_role"]
    patch = next(result for result in report["tasks"] if result["task"] == "patch-rounding")
    assert patch["stages"][-1] == "remember" and "commit" in patch["stages"]


async def test_a_wrong_reference_fails_the_deterministic_grader(tmp_path):
    import shutil
    shutil.copytree(SUITE, tmp_path / "suite")
    path = tmp_path / "suite" / "tasks" / "patch-rounding.json"
    task = BenchTask.model_validate_json(path.read_text(encoding="utf-8"))
    task.reference.edits = task.reference.edits[:1]  # imports the constant, never uses it
    path.write_text(task.model_dump_json(), encoding="utf-8")
    report = await run_suite(tmp_path / "suite", ["patch-rounding"])
    assert report["tasks"][0]["grade"]["verdict"] == "fail" and report["summary"]["failed"] == 1


def test_cli_writes_report_and_signals_failure(tmp_path, capsys):
    output = tmp_path / "report.json"
    assert main(["--task", "patch-discount", "--output", str(output)]) == 0
    assert json.loads(output.read_text(encoding="utf-8"))["summary"]["passed"] == 1
    assert main(["--task", "nope"]) == 2


def test_probe_matches_structured_entries_not_shared_words():
    prompt = {"source_context": {"files": [{"path": "pricing.py"}]}, "task_context": {"task": {"scope": ["pricing.py"]}}}
    assert has_entry(prompt, "scope", ["pricing.py"])
    assert not has_entry({"source_context": {"files": [{"path": "pricing.py"}]}}, "scope", ["pricing.py"])
