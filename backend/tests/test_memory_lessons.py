from sabre.memory_lessons import MAX_REPAIR_ENTRIES, append_repair, repair_entry, repair_lesson
from sabre.models import Budget, DeliveryEvidence, Status, Task, WorkOrder

BLOCKING = {"fingerprint": "f1", "scanner": "gitleaks", "category": "secret", "severity": "critical", "title": "Possible token in config.py"}


def delivered(**values):
    work = WorkOrder(project_id="project-1", mode="patch", objective="Fix the  total\ncalculation", acceptance=["Totals add up"],
                     budget=Budget(max_cost_usd=1), idempotency_key="lesson-test-0001", **values)
    work.evidence = DeliveryEvidence(commit="c" * 40, snapshot_digest="d" * 64, profile_digest="e" * 64, rules_version="rules",
                                     gates=[], findings=[], review="Reviewed")
    return work


def test_failed_checks_explain_the_cycle_without_boilerplate_reviews():
    state = {"qa_ok": False, "qa_review": "Model QA was not run because deterministic gates failed", "review": "Verification did not pass"}
    entry = repair_entry(state, ["pytest -q", "ruff check"], {"findings": [BLOCKING]}, 1)
    assert entry == {"cycle": 1, "failed_checks": ["pytest -q", "ruff check"], "omitted_checks": 0,
                     "security": ["secret: Possible token in config.py"], "qa": None, "review": None}


def test_rejections_are_quoted_only_when_the_checks_passed():
    state = {"qa_ok": True, "qa_review": "Coverage fine", "review_ok": False, "review": "Edge case for empty input\nis missing. " * 40}
    entry = repair_entry(state, [], {"findings": []}, 2)
    assert entry["qa"] is None and entry["failed_checks"] == []
    assert entry["review"].startswith("Edge case for empty input is missing.") and len(entry["review"]) == 240 and entry["review"].endswith("…")


def test_the_log_keeps_what_broke_first_and_the_latest_cycles():
    log = None
    for cycle in range(1, 13):
        log = append_repair(log, {"cycle": cycle})
    assert len(log) == MAX_REPAIR_ENTRIES
    assert [entry["cycle"] for entry in log] == [1, 6, 7, 8, 9, 10, 11, 12]


def test_a_lesson_needs_repairs_and_delivery_evidence():
    assert repair_lesson(delivered(), []) is None
    assert repair_lesson(delivered(), None) is None
    undelivered = delivered()
    undelivered.evidence = None
    assert repair_lesson(undelivered, [{"cycle": 1, "failed_checks": ["pytest"]}]) is None


def test_the_lesson_is_deterministic_and_carries_delivery_provenance():
    work = delivered(repair_cycles_used=2, tasks=[Task(title="Fix", role="developer", status=Status.COMPLETED, result="Rounded before summing.")])
    log = [repair_entry({}, ["pytest -q"], {"findings": []}, 1),
           repair_entry({"qa_ok": False, "qa_review": "No test for negatives", "review_ok": True}, [], {"findings": []}, 2)]
    lesson = repair_lesson(work, log)
    assert lesson == repair_lesson(work, log)
    assert (lesson.kind, lesson.scope, lesson.source_commit, lesson.source_work_id, lesson.evidence_digest) == (
        "lesson", "project", "c" * 40, work.id, "d" * 64)
    assert lesson.content.splitlines() == [
        "Repair lesson: Fix the total calculation",
        "Verification passed after 2 repair cycles; delivered at commit cccccccccccc.",
        "- Cycle 1: failed `pytest -q`.",
        '- Cycle 2: QA rejected: "No test for negatives".',
        'Change that passed (developer summary, observed): "Rounded before summing."',
    ]
