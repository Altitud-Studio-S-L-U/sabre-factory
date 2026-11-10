import asyncio

import pytest

from integration.test_postgres import fixture_work
from integration.test_postgres import repository as repository
from sabre.context_receipts import ContextReceipt
from sabre.models import DomainError
from tests.test_context_receipts import receipt


async def rows(repo, work_id):
    async with repo.connection() as conn:
        return await (await conn.execute("SELECT * FROM model_usage WHERE work_id=%s ORDER BY id", (work_id,))).fetchall()


async def test_context_receipt_shares_reservation_and_survives_settlement_without_changing_legacy(repository):
    repo, project, work = await fixture_work(repository)
    legacy = await repo.reserve_usage(work, 100, 0, 10)
    before = await rows(repo, work.id)
    assert before[0]["context_receipt"] is None
    assert await repo.audit_context_usage(work.id) is None
    context = ContextReceipt.model_validate(receipt(work.id, project.id, restored_pages=2))
    current = await repo.reserve_usage(work, 200, 0, 10, context_receipt=context)
    saved = next(row for row in await rows(repo, work.id) if row["id"] == current)
    assert saved["context_receipt"] == context.model_dump(mode="json")
    assert saved["reserved_tokens"] == 200 and saved["actual_tokens"] is None
    report = await repo.audit_context_usage(work.id)
    assert (report.requests_with_context, report.requests_without_context, report.restored_pages) == (1, 1, 2)
    await repo.settle_usage(current, 65, 0)
    after = await rows(repo, work.id)
    assert next(row for row in after if row["id"] == legacy) == before[0]
    settled = next(row for row in after if row["id"] == current)
    assert {key: value for key, value in settled.items() if key not in {"actual_tokens", "actual_usd"}} == {
        key: value for key, value in saved.items() if key not in {"actual_tokens", "actual_usd"}}
    assert settled["actual_tokens"] == 65
    assert (await repo.audit_context_usage(work.id)) == report
    usage = await repo.audit_usage(work.id)
    assert (usage["calls"], usage["tokens"], usage["unknown_reserved_tokens"]) == (2, 165, 100)


async def test_context_scope_and_contract_fail_before_a_ledger_row_is_created(repository):
    repo, project, work = await fixture_work(repository)
    cases = [receipt(work.id, "another-project"), receipt(work.id, project.id, prompt="private")]
    for context in cases:
        with pytest.raises(DomainError):
            await repo.reserve_usage(work, 100, 0, 10, context_receipt=context)
    stale_work = work.model_copy(update={"plan_revision": 2})
    with pytest.raises(DomainError) as error:
        await repo.reserve_usage(stale_work, 100, 0, 10, context_receipt=receipt(work.id, project.id, revision=2))
    assert error.value.code == "CONTEXT_RECEIPT_SCOPE"
    assert await rows(repo, work.id) == []


async def test_model_consumption_groups_only_recorded_selection_and_preserves_unknown_reservations(repository):
    repo, project, work = await fixture_work(repository)
    await repo.reserve_usage(work, 100, 0, 10)
    context = receipt(work.id, project.id, model_provider="claude_cli", model_name="sonnet", model_configuration_revision=2)
    measured = await repo.reserve_usage(work, 200, 0, 10, context_receipt=context)
    await repo.settle_usage(measured, 65, 0)
    await repo.reserve_usage(work, 150, 0, 10, context_receipt=context)
    report = await repo.audit_model_usage(work.id)
    legacy = next(value for value in report if value["model_provider"] is None)
    claude = next(value for value in report if value["model_provider"] == "claude_cli")
    assert legacy["role"] is None and legacy["unknown_reserved_tokens"] == 100
    assert (claude["role"], claude["model_name"], claude["configuration_revision"]) == ("developer", "sonnet", 2)
    assert (claude["calls"], claude["settled_calls"], claude["measured_tokens"], claude["unknown_reserved_tokens"]) == (2, 1, 65, 150)
    total = await repo.usage(work.id)
    assert sum(value["measured_tokens"] + value["unknown_reserved_tokens"] for value in report) == total["tokens"]


async def test_concurrent_budget_admission_commits_exactly_one_complete_receipt(repository):
    repo, project, work = await fixture_work(repository)
    work.budget.max_calls = 1
    first = receipt(work.id, project.id)
    second = receipt(work.id, project.id, sent_digest="e" * 64)
    results = await asyncio.gather(repo.reserve_usage(work, 100, 0, 10, context_receipt=first),
        repo.reserve_usage(work, 100, 0, 10, context_receipt=second), return_exceptions=True)
    assert sum(isinstance(result, str) for result in results) == 1
    errors = [result for result in results if isinstance(result, DomainError)]
    assert len(errors) == 1 and errors[0].code == "BUDGET_EXHAUSTED"
    saved = await rows(repo, work.id)
    assert len(saved) == 1 and saved[0]["context_receipt"]["sent_digest"] in {"c" * 64, "e" * 64}
    assert saved[0]["reserved_tokens"] == 100 and saved[0]["actual_tokens"] is None
