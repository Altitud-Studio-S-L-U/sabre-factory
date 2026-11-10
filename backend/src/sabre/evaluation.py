"""Evaluate observed factory orders against independent, source-linked annotations."""

import argparse
import asyncio
import json
import math
import os
import sys
from collections import Counter
from collections.abc import Sequence
from datetime import datetime
from pathlib import Path
from statistics import fmean, median
from typing import Any, Literal
from urllib.parse import quote, urlsplit

import httpx
from pydantic import Field, SecretStr, ValidationError, model_validator

from sabre.models import Contract, DomainError, Status, WorkOrder, now
from sabre.security import SecretGuard
from sabre.settings import load_bootstrap, reject_secret_environment

ExpectedOutcome = Literal["complete", "block", "unknown"]
FunctionalVerdict = Literal["pass", "fail", "unknown", "not_applicable"]


class EvaluationCase(Contract):
    case_id: str = Field(pattern=r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$")
    work_id: str = Field(pattern=r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")
    expected_outcome: ExpectedOutcome = "unknown"
    functional_verdict: FunctionalVerdict = "unknown"
    label_source: str | None = Field(default=None, min_length=1, max_length=500)
    expected_plan_revision: int | None = Field(default=None, ge=1)
    reference_commit: str | None = Field(default=None, pattern=r"^(?:[a-f0-9]{40}|[a-f0-9]{64})$")

    @model_validator(mode="after")
    def independent_labels_have_provenance(self):
        if (self.expected_outcome != "unknown" or self.functional_verdict != "unknown") and not (self.label_source and self.label_source.strip()):
            raise ValueError("Known annotations need an independent source reference")
        if (self.expected_outcome != "unknown" or self.functional_verdict != "unknown") and self.expected_plan_revision is None:
            raise ValueError("Known annotations must identify their plan revision")
        if self.functional_verdict in {"pass", "fail"} and not self.reference_commit:
            raise ValueError("Functional annotations must identify the assessed delivery commit")
        if self.functional_verdict == "not_applicable" and self.expected_outcome != "block":
            raise ValueError("A delivery case needs a functional verdict or an explicit unknown")
        return self


class EvaluationDataset(Contract):
    schema_version: Literal[1] = 1
    cases: list[EvaluationCase] = Field(max_length=5000)

    @model_validator(mode="after")
    def unique_cases_and_orders(self):
        if len({case.case_id for case in self.cases}) != len(self.cases) or len({case.work_id for case in self.cases}) != len(self.cases):
            raise ValueError("Each annotated case and work order must be unique")
        return self


class CaseResult(EvaluationCase):
    status: Status | None = None
    mode: str | None = None
    phase: str | None = None
    graph_version: str | None = None
    plan_revision: int | None = None
    commit: str | None = None
    created_at: datetime | None = None
    updated_at: datetime | None = None
    functional_success: bool | None = None
    outcome_matches_label: bool | None = None
    false_approval: bool | None = None
    incorrect_block: bool | None = None
    calls: int | None = None
    tokens: int | None = None
    recorded_cost_usd: float | None = None
    active_seconds: float | None = None
    elapsed_total_seconds: float | None = None
    error_code: str | None = None
    unknowns: list[str] = Field(default_factory=list)


class EvaluationReport(Contract):
    schema_version: Literal[1] = 1
    generated_at: datetime = Field(default_factory=now)
    cases: list[CaseResult]
    complete: bool
    metrics: dict[str, Any]


def _unavailable(case: EvaluationCase, code: str) -> CaseResult:
    return CaseResult(**case.model_dump(), error_code=code, unknowns=["work_unavailable"])


def assess(case: EvaluationCase, work: WorkOrder) -> CaseResult:
    """Use independent labels and recorded measurements; never infer functional pass."""
    if work.id != case.work_id:
        return _unavailable(case, "WORK_ID_MISMATCH")
    result = CaseResult(**case.model_dump(), status=work.status, mode=work.mode, phase=work.phase, graph_version=work.graph_version,
        plan_revision=work.plan_revision, commit=work.evidence.commit if work.evidence else None,
        created_at=work.created_at, updated_at=work.updated_at)
    if case.expected_outcome == "unknown":
        result.unknowns.append("expected_outcome_unjudged")
    if case.functional_verdict == "unknown":
        result.unknowns.append("functional_result_unjudged")
    labels_current = (case.expected_plan_revision is None or case.expected_plan_revision == work.plan_revision) and (case.reference_commit is None or case.reference_commit == result.commit)
    if work.phase == "security_watch":
        result.error_code = "NON_DELIVERY_REPORT"
        result.unknowns.append("watch_report_not_a_delivery")
    elif not labels_current:
        result.error_code = "STALE_ANNOTATION"
        result.unknowns.append("annotation_revision_or_commit_mismatch")
    elif work.status == Status.COMPLETED:
        if case.functional_verdict in {"pass", "fail"}:
            result.functional_success = case.functional_verdict == "pass"
        if case.expected_outcome != "unknown":
            result.outcome_matches_label = case.expected_outcome == "complete"
        if case.expected_outcome == "block" or case.functional_verdict == "fail":
            result.false_approval = True
        elif case.expected_outcome == "complete" and case.functional_verdict == "pass":
            result.false_approval = False
    elif work.status in {Status.BLOCKED, Status.FAILED}:
        if case.expected_outcome != "unknown":
            result.incorrect_block = case.expected_outcome == "complete"
            result.outcome_matches_label = not result.incorrect_block
    else:
        result.unknowns.append("work_cancelled" if work.status == Status.CANCELLED else "work_in_progress")
    usage = (work.calls_used, work.tokens_used, work.cost_usd, work.active_seconds_used)
    if all(math.isfinite(value) and value >= 0 for value in usage):
        result.calls, result.tokens = work.calls_used, work.tokens_used
        result.recorded_cost_usd, result.active_seconds = work.cost_usd, work.active_seconds_used
    else:
        result.unknowns.append("invalid_recorded_usage")
    if work.created_at.utcoffset() is not None and work.updated_at.utcoffset() is not None and work.updated_at >= work.created_at:
        result.elapsed_total_seconds = (work.updated_at - work.created_at).total_seconds()
    else:
        result.unknowns.append("invalid_timestamps")
    return result


def _metric(values: list[bool | None]) -> dict[str, int | float | None]:
    known = [value for value in values if value is not None]
    count = sum(known)
    return {"eligible": len(values), "assessed": len(known), "count": count, "unknown": len(values) - len(known), "rate": count / len(known) if known else None}


def _duration(values: list[float | None]) -> dict[str, int | float | None]:
    known = [value for value in values if value is not None]
    return {"assessed": len(known), "unknown": len(values) - len(known), "mean_seconds": fmean(known) if known else None, "p50_seconds": median(known) if known else None, "max_seconds": max(known) if known else None}


def summarize(results: list[CaseResult]) -> EvaluationReport:
    usage = [result for result in results if result.calls is not None]
    complete = bool(results) and all(not result.unknowns and result.outcome_matches_label is not None for result in results)
    return EvaluationReport(cases=results, complete=complete, metrics={
        "case_count": len(results),
        "statuses": dict(Counter(result.status.value if result.status else "unavailable" for result in results)),
        "outcome_matches_label": _metric([result.outcome_matches_label for result in results]),
        "functional_deliveries": _metric([result.functional_success for result in results if result.status in {Status.COMPLETED, None} and result.functional_verdict != "not_applicable"]),
        "false_approvals": _metric([result.false_approval for result in results if result.status in {Status.COMPLETED, None}]),
        "incorrect_blocks": _metric([result.incorrect_block for result in results if result.status in {Status.BLOCKED, Status.FAILED, None}]),
        "usage": {"assessed": len(usage), "unknown": len(results) - len(usage),
            "calls": sum(result.calls or 0 for result in usage) if usage else None,
            "tokens": sum(result.tokens or 0 for result in usage) if usage else None,
            "recorded_cost_usd": sum(result.recorded_cost_usd or 0 for result in usage) if usage else None},
        "elapsed_total": _duration([result.elapsed_total_seconds for result in results]),
        "active_time": _duration([result.active_seconds for result in results]),
        "completed_latency": _duration([result.elapsed_total_seconds for result in results if result.status == Status.COMPLETED]),
        "unjudged_functional_cases": sum(result.functional_verdict == "unknown" for result in results),
    })


async def evaluate_cases(dataset: EvaluationDataset, client: httpx.AsyncClient, guard: SecretGuard | None = None) -> EvaluationReport:
    guard = guard or SecretGuard()
    guard.check(dataset.model_dump(mode="json"))
    results = []
    for case in dataset.cases:
        try:
            response = await client.get(f"/api/v1/work/{quote(case.work_id, safe='')}")
            response.raise_for_status()
            raw = response.json()
            guard.check(raw)
            result = assess(case, WorkOrder.model_validate(raw))
        except httpx.HTTPStatusError as error:
            result = _unavailable(case, f"HTTP_{error.response.status_code}")
        except httpx.RequestError:
            result = _unavailable(case, "API_UNAVAILABLE")
        except (ValidationError, ValueError, TypeError):
            result = _unavailable(case, "INVALID_WORK_RESPONSE")
        except DomainError as error:
            result = _unavailable(case, error.code)
        results.append(result)
    report = summarize(results)
    guard.check(report.model_dump(mode="json"))
    return report


def report_exit_code(report: EvaluationReport) -> int:
    if report.metrics["false_approvals"]["count"] or report.metrics["incorrect_blocks"]["count"]:
        return 1
    return 0 if report.complete else 2


def _api_url(value: str) -> str:
    try:
        parsed = urlsplit(value)
        httpx.URL(value)
        _ = parsed.port  # urlsplit validates port syntax only when this property is read.
    except (ValueError, httpx.InvalidURL):
        raise DomainError("INVALID_API_URL", "The API URL has an unsupported format") from None
    local = parsed.scheme == "http" and parsed.hostname in {"localhost", "127.0.0.1", "::1", "api"}
    if not parsed.hostname or (parsed.scheme != "https" and not local) or parsed.username or parsed.password or parsed.query or parsed.fragment or parsed.path not in {"", "/"}:
        raise DomainError("INVALID_API_URL", "Use the root HTTPS or local API URL without credentials")
    return value.rstrip("/")


async def _collect(dataset: EvaluationDataset, api_url: str, token: str) -> EvaluationReport:
    async with httpx.AsyncClient(base_url=api_url, headers={"Authorization": f"Bearer {token}"}, timeout=20, follow_redirects=False) as client:
        return await evaluate_cases(dataset, client, SecretGuard([token]))


def main(argv: Sequence[str] | None = None, *, auth_token: SecretStr | None = None) -> int:
    parser = argparse.ArgumentParser(description="Evaluar encargos reales de SABRE contra casos anotados independientes")
    parser.add_argument("--cases", required=True, type=Path, help="Annotated case JSON; code in this file will not be executed")
    parser.add_argument("--api-url", default=os.environ.get("SABRE_API_URL", "http://127.0.0.1:8000"))
    parser.add_argument("--bootstrap-file", type=Path, help="Private control bootstrap file; defaults to SABRE_BOOTSTRAP_FILE")
    parser.add_argument("--output", required=True, type=Path, help="JSON report path")
    args = parser.parse_args(argv)
    try:
        reject_secret_environment()
        credential = auth_token if auth_token is not None else SecretStr(load_bootstrap(args.bootstrap_file, kind="control").get("auth_token", ""))
        token = credential.get_secret_value()
        if not token.strip():
            raise DomainError("AUTH_TOKEN_REQUIRED", "The private control bootstrap requires an access token")
        if args.cases.resolve() == args.output.resolve():
            raise DomainError("INVALID_OUTPUT_PATH", "The report must use a different path from the cases")
        if args.cases.stat().st_size > 5_000_000:
            raise DomainError("INVALID_EVALUATION_CASES", "The evaluation dataset exceeds the size limit")
        try:
            dataset = EvaluationDataset.model_validate_json(args.cases.read_text(encoding="utf-8-sig"))
        except (ValidationError, ValueError):
            raise DomainError("INVALID_EVALUATION_CASES", "Review case format, labels and provenance") from None
        report = asyncio.run(_collect(dataset, _api_url(args.api_url), token))
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(report.model_dump_json(indent=2), encoding="utf-8")
    except DomainError as error:
        print(f"{error.code}: {error.message}", file=sys.stderr)
        return 2
    except (OSError, ValueError, httpx.InvalidURL):
        print("EVALUATION_IO_ERROR: Could not read the dataset or write the report", file=sys.stderr)
        return 2
    print(json.dumps({"cases": len(report.cases), "complete": report.complete, "false_approvals": report.metrics["false_approvals"]["count"], "incorrect_blocks": report.metrics["incorrect_blocks"]["count"]}, ensure_ascii=False))
    return report_exit_code(report)


if __name__ == "__main__":
    raise SystemExit(main())
