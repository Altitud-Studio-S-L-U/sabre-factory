import json

import pytest

from sabre.bench import SUITE, BenchTask, has_entry, load_tasks, main, run_suite
from sabre.models import DomainError


def test_suite_tasks_are_valid_and_reference_existing_fixtures():
    tasks = load_tasks(SUITE)
    assert {task.id for task in tasks} >= {"patch-rounding", "patch-discount", "patch-discount-repair", "audit-pricing"}
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
                                         "deterministic_gates_before_model_qa", "qa_receives_gate_results",
                                         "repair_receives_work_notes"}
        applicable = result["mode"] != "audit"
        assert all(isinstance(value, bool) if applicable or not name.startswith("developer_") else value is None
                   for name, value in result["probes"].items() if name != "repair_receives_work_notes")
        # Only the repair fixture runs a second developer attempt; elsewhere the probe is not applicable.
        repaired = result["task"] == "patch-discount-repair"
        assert result["probes"]["repair_receives_work_notes"] is (True if repaired else None)
        assert result["work_notes"] == ({"scopes": 1, "notes": 1} if repaired else {"scopes": 0, "notes": 0})
        assert set(result["budget_feasibility"]) == {"reservation_at_context_limit", "budget_max_tokens", "fits"}
        # Loop-correctness properties: the planned task reaches the developer, deterministic gates
        # run before model QA and reach it, and one call at the context ceiling fits the budget.
        assert result["probes"]["deterministic_gates_before_model_qa"] and result["probes"]["qa_receives_gate_results"]
        assert applicable is False or (result["probes"]["developer_receives_task_acceptance"] and result["probes"]["developer_receives_task_scope"])
        assert result["budget_feasibility"]["fits"]
        assert result["calls"]["by_role"]["qa"] == 1
        # Every estimated token belongs to a specialist, so the share by role adds up.
        assert set(result["tokens"]["estimated_by_role"]) == set(result["calls"]["by_role"])
        assert sum(result["tokens"]["estimated_by_role"].values()) == result["tokens"]["estimated_total"]
    audit = next(result for result in report["tasks"] if result["mode"] == "audit")
    assert audit["grade"]["source_unchanged"] and "developer" not in audit["calls"]["by_role"]
    patch = next(result for result in report["tasks"] if result["task"] == "patch-rounding")
    assert patch["stages"][-1] == "remember" and "commit" in patch["stages"]
    repair = next(result for result in report["tasks"] if result["task"] == "patch-discount-repair")
    assert repair["calls"]["by_role"]["developer"] > patch["calls"]["by_role"]["developer"]
    assert repair["tools"]["calls"]["record_note"] == 1 and repair["stages"].count("implement") == 2


async def test_the_reference_policy_measures_the_same_twice_apart_from_timing():
    def mechanics(result):
        # Maps compare by key: tools of one turn finish in either order. Timing is the only field left out.
        return {key: value for key, value in result.items() if key != "wall_ms"} | {
            "tools": {key: value for key, value in result["tools"].items() if key != "total_ms"}}

    first = await run_suite(selected=["patch-discount-repair", "audit-pricing"])
    second = await run_suite(selected=["patch-discount-repair", "audit-pricing"])
    assert [mechanics(result) for result in first["tasks"]] == [mechanics(result) for result in second["tasks"]]


async def test_repair_attempt_without_its_note_repeats_the_dead_end(monkeypatch):
    from sabre.work_notes import WorkNotes
    # Without injected notes the reference policy cannot know its first approach failed.
    monkeypatch.setattr(WorkNotes, "brief", lambda self: None)
    report = await run_suite(SUITE, ["patch-discount-repair"])
    result = report["tasks"][0]
    assert result["status"] == "blocked" and result["error_code"] == "TASK_REJECTED"
    assert result["probes"]["repair_receives_work_notes"] is False


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


async def test_an_audit_that_fits_its_window_keeps_what_it_read_and_a_long_one_rewrites_only_in_batches():
    report = await run_suite(selected=["audit-ledger", "audit-ledger-full"])
    fits, long = (next(result for result in report["tasks"] if result["task"] == name) for name in ("audit-ledger", "audit-ledger-full"))
    assert fits["grade"]["verdict"] == long["grade"]["verdict"] == "pass"
    # Six modules read over three turns stay below the high mark: nothing leaves the view, so the agent
    # recovers nothing and every request only appends to the one before it.
    assert fits["context"]["recoveries"] == 0 and "read_context" not in fits["tools"]["calls"]
    prefix = fits["context"]["prefix"]
    assert (prefix["turns"], prefix["batch_turns"], prefix["stable_turns"]) == (4, 0, 4) and prefix["min_share"] > 0.99
    # Sixteen modules cannot all stay in view. The oldest leave in batches, the agent pages back the three
    # it revisits, and a turn without a batch keeps the previous request whole.
    assert long["context"]["recoveries"] == 3 and long["tools"]["calls"]["read_context"] == 3
    prefix = long["context"]["prefix"]
    assert 0 < prefix["batch_turns"] < prefix["turns"] and prefix["min_share_without_batch"] > 0.99
    assert long["budget_feasibility"]["budget_max_tokens"] == 300000


async def test_without_the_marks_the_audit_that_fits_loses_what_it_read_two_turns_ago(monkeypatch):
    # The policy the marks replace: a result leaves as soon as it is outside the protected turns.
    monkeypatch.setattr("sabre.agents.ARCHIVE_HIGH_WATER", 0.0)
    monkeypatch.setattr("sabre.agents.ARCHIVE_LOW_WATER", 0.0)
    result = (await run_suite(selected=["audit-ledger"]))["tasks"][0]
    assert result["grade"]["verdict"] == "pass"
    assert result["context"]["recoveries"] == 2 and result["tools"]["calls"]["read_context"] == 2
    assert result["context"]["prefix"]["batch_turns"] == 2 and result["context"]["prefix"]["min_share"] < 0.5
