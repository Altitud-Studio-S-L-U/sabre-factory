import json
from datetime import UTC, datetime, timedelta

import httpx
import pytest
from pydantic import SecretStr, ValidationError

from sabre.evaluation import (
    EvaluationCase,
    EvaluationDataset,
    assess,
    evaluate_cases,
    main,
    report_exit_code,
    summarize,
)
from sabre.models import Budget, DeliveryEvidence, Status, WorkOrder
from sabre.security import SecretGuard

COMMIT = "a" * 40


def order(status=Status.COMPLETED, **updates):
    created = datetime(2026, 11, 5, 10, tzinfo=UTC)
    values = dict(id="work-one", project_id="project-one", mode="patch", objective="Synthetic unit fixture; do not copy this content into reports", acceptance=["Returns the expected result"], budget=Budget(max_cost_usd=1), idempotency_key="evaluation-unit-fixture", status=status, created_at=created, updated_at=created + timedelta(seconds=120), calls_used=3, tokens_used=1234, cost_usd=0.125, active_seconds_used=12,
        evidence=DeliveryEvidence(commit=COMMIT, snapshot_digest="b" * 64, profile_digest="c" * 64, rules_version="unit-test", gates=[], findings=[], review="Independent unit-test fixture"))
    return WorkOrder(**(values | updates))


def case(**updates):
    values = dict(case_id="python-empty-input", work_id="work-one", expected_outcome="complete", functional_verdict="pass", label_source="test-oracle:python-empty-input-v1", expected_plan_revision=1, reference_commit=COMMIT)
    return EvaluationCase(**(values | updates))


@pytest.mark.parametrize("status,expected,functional,false_approval,incorrect_block,exit_code", [
    (Status.COMPLETED, "complete", "pass", False, None, 0),
    (Status.COMPLETED, "complete", "fail", True, None, 1),
    (Status.COMPLETED, "block", "not_applicable", True, None, 1),
    (Status.BLOCKED, "complete", "pass", None, True, 1),
    (Status.FAILED, "complete", "pass", None, True, 1),
    (Status.BLOCKED, "block", "not_applicable", None, False, 0),
    (Status.FAILED, "block", "not_applicable", None, False, 0),
])
def test_independent_labels_distinguish_false_approvals_and_incorrect_blocks(status, expected, functional, false_approval, incorrect_block, exit_code):
    result = assess(case(expected_outcome=expected, functional_verdict=functional), order(status))
    assert result.false_approval is false_approval
    assert result.incorrect_block is incorrect_block
    assert report_exit_code(summarize([result])) == exit_code


@pytest.mark.parametrize("status", [Status.QUEUED, Status.RUNNING, Status.WAITING_INPUT, Status.PAUSED, Status.CANCELLED])
def test_pending_paused_or_cancelled_work_is_incomplete_without_a_false_block(status):
    result = assess(case(), order(status))
    report = summarize([result])
    assert result.incorrect_block is None
    assert not report.complete
    assert report.metrics["incorrect_blocks"]["rate"] is None
    assert report_exit_code(report) == 2


def test_completed_without_an_independent_functional_verdict_remains_unknown():
    result = assess(case(functional_verdict="unknown", reference_commit=None), order())
    report = summarize([result])
    assert result.functional_success is None
    assert result.false_approval is None
    assert report.metrics["functional_deliveries"]["unknown"] == 1
    assert report.metrics["functional_deliveries"]["rate"] is None
    assert report.metrics["false_approvals"]["unknown"] == 1
    assert report_exit_code(report) == 2


@pytest.mark.parametrize("status", [Status.COMPLETED, Status.BLOCKED])
def test_watch_reports_are_not_scored_as_development_deliveries_or_blocks(status):
    result = assess(case(expected_outcome="block", functional_verdict="not_applicable"), order(status, phase="security_watch"))
    report = summarize([result])
    assert result.error_code == "NON_DELIVERY_REPORT"
    assert result.false_approval is None
    assert result.incorrect_block is None
    assert result.outcome_matches_label is None
    assert report_exit_code(report) == 2


@pytest.mark.parametrize("changes", [{"plan_revision": 2}, {"evidence": None}])
def test_stale_annotation_never_scores_a_changed_revision_or_commit(changes):
    result = assess(case(), order(**changes))
    assert result.error_code == "STALE_ANNOTATION"
    assert result.functional_success is None
    assert result.false_approval is None
    assert result.outcome_matches_label is None
    assert result.calls == 3
    assert report_exit_code(summarize([result])) == 2


def test_usage_and_elapsed_wall_time_are_preserved_separately_from_active_time():
    report = summarize([assess(case(), order())])
    assert report.metrics["usage"] == {"assessed": 1, "unknown": 0, "calls": 3, "tokens": 1234, "recorded_cost_usd": 0.125}
    assert report.metrics["elapsed_total"]["mean_seconds"] == 120
    assert report.metrics["active_time"]["mean_seconds"] == 12
    assert report.metrics["completed_latency"]["mean_seconds"] == 120
    assert "Synthetic unit fixture" not in report.model_dump_json()


def test_invalid_measurements_are_unknown_instead_of_becoming_zero_or_negative():
    result = assess(case(), order(cost_usd=-1, updated_at=datetime(2026, 11, 4, tzinfo=UTC)))
    report = summarize([result])
    assert result.calls is None
    assert result.elapsed_total_seconds is None
    assert report.metrics["usage"]["recorded_cost_usd"] is None
    assert report.metrics["elapsed_total"]["mean_seconds"] is None
    assert report_exit_code(report) == 2


def test_empty_evaluation_has_no_fabricated_pass_rate_or_consumption():
    report = summarize([])
    assert report.metrics["outcome_matches_label"]["rate"] is None
    assert report.metrics["usage"]["calls"] is None
    assert not report.complete
    assert report_exit_code(report) == 2


@pytest.mark.parametrize("changes", [{"label_source": None}, {"expected_plan_revision": None}, {"reference_commit": None}])
def test_known_functional_labels_need_source_revision_and_commit(changes):
    with pytest.raises(ValidationError):
        case(**changes)


def test_duplicate_case_or_work_ids_do_not_double_count_observations():
    with pytest.raises(ValidationError):
        EvaluationDataset(cases=[case(), case(case_id="another-case")])


async def test_collects_authenticated_work_responses_via_http_without_mutating_api():
    requests = []

    def api(request):
        requests.append(request)
        assert request.method == "GET"
        assert request.url.path == "/api/v1/work/work-one"
        assert request.headers["Authorization"] == "Bearer synthetic-owner-token"
        return httpx.Response(200, json=order().model_dump(mode="json"))

    async with httpx.AsyncClient(base_url="http://test", headers={"Authorization": "Bearer synthetic-owner-token"}, transport=httpx.MockTransport(api)) as client:
        report = await evaluate_cases(EvaluationDataset(cases=[case()]), client)
    assert len(requests) == 1
    assert report.complete
    assert report.cases[0].status == Status.COMPLETED
    assert report.cases[0].commit == COMMIT


@pytest.mark.parametrize("failure", ["404", "malformed", "network", "secret"])
async def test_unavailable_or_unsafe_api_results_stay_unknown_without_echoing_private_content(failure):
    def api(request):
        if failure == "network":
            raise httpx.ConnectError("private-provider-detail", request=request)
        if failure == "404":
            return httpx.Response(404, json={"message": "private-provider-detail"})
        if failure == "malformed":
            return httpx.Response(200, json={"private": "private-provider-detail"})
        return httpx.Response(200, json=order(objective="sk-proj-" + "x" * 40).model_dump(mode="json"))

    async with httpx.AsyncClient(base_url="http://test", transport=httpx.MockTransport(api)) as client:
        report = await evaluate_cases(EvaluationDataset(cases=[case()]), client, SecretGuard())
    assert not report.complete
    assert report.cases[0].status is None
    assert report.cases[0].false_approval is None
    assert report.metrics["usage"]["calls"] is None
    assert "private-provider-detail" not in report.model_dump_json()
    assert "sk-proj-" not in report.model_dump_json()
    assert report_exit_code(report) == 2


def test_cli_missing_credentials_and_invalid_input_do_not_echo_or_overwrite_files(tmp_path, monkeypatch, capsys):
    cases = tmp_path / "cases.json"
    output = tmp_path / "report.json"
    cases.write_text('{"private": "synthetic-private-value"}', encoding="utf-8")
    monkeypatch.delenv("SABRE_AUTH_TOKEN", raising=False)
    monkeypatch.delenv("SABRE_BOOTSTRAP_FILE", raising=False)
    assert main(["--cases", str(cases), "--output", str(output)]) == 2
    assert not output.exists()
    assert main(["--cases", str(cases), "--output", str(output)], auth_token=SecretStr("synthetic-owner-token")) == 2
    assert "synthetic-private-value" not in capsys.readouterr().err
    assert not output.exists()
    assert main(["--cases", str(cases), "--output", str(cases)], auth_token=SecretStr("synthetic-owner-token")) == 2
    assert cases.read_text(encoding="utf-8") == '{"private": "synthetic-private-value"}'


def test_cli_writes_the_report_and_propagates_failure_exit_status(tmp_path, monkeypatch, capsys):
    cases = tmp_path / "cases.json"
    output = tmp_path / "report.json"
    cases.write_text(EvaluationDataset(cases=[case(functional_verdict="fail")]).model_dump_json(), encoding="utf-8")
    monkeypatch.delenv("SABRE_AUTH_TOKEN", raising=False)

    async def collect(dataset, api_url, token):
        assert token == "synthetic-owner-token"
        return summarize([assess(dataset.cases[0], order())])

    monkeypatch.setattr("sabre.evaluation._collect", collect)
    assert main(["--cases", str(cases), "--output", str(output)], auth_token=SecretStr("synthetic-owner-token")) == 1
    assert json.loads(output.read_text(encoding="utf-8"))["metrics"]["false_approvals"]["count"] == 1
    assert "synthetic-owner-token" not in capsys.readouterr().out


def test_cli_reads_only_the_requested_private_control_bootstrap(tmp_path, monkeypatch, capsys):
    cases, output = tmp_path / "cases.json", tmp_path / "report.json"
    private_file = tmp_path / "control-bootstrap.json"
    cases.write_text(EvaluationDataset(cases=[]).model_dump_json(), encoding="utf-8")
    monkeypatch.delenv("SABRE_AUTH_TOKEN", raising=False)
    reads = []

    def bootstrap(path, kind):
        reads.append((path, kind))
        return {"auth_token": "synthetic-bootstrap-owner-token"}

    async def collect(dataset, api_url, token):
        assert token == "synthetic-bootstrap-owner-token"
        return summarize([])

    monkeypatch.setattr("sabre.evaluation.load_bootstrap", bootstrap)
    monkeypatch.setattr("sabre.evaluation._collect", collect)
    assert main(["--cases", str(cases), "--output", str(output), "--bootstrap-file", str(private_file)]) == 2
    assert reads == [(private_file, "control")]
    captured = capsys.readouterr()
    assert "synthetic-bootstrap-owner-token" not in captured.out + captured.err


def test_cli_refuses_raw_secret_environment_without_echoing_it(tmp_path, monkeypatch, capsys):
    monkeypatch.setenv("SABRE_AUTH_TOKEN", "synthetic-forbidden-environment-value")
    assert main(["--cases", str(tmp_path / "cases.json"), "--output", str(tmp_path / "report.json")], auth_token=SecretStr("synthetic-injected-owner-token")) == 2
    captured = capsys.readouterr()
    assert "synthetic-forbidden-environment-value" not in captured.out + captured.err
