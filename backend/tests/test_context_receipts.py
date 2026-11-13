from copy import deepcopy
from types import SimpleNamespace

import pytest

from sabre.context_receipts import ContextReceipt, aggregate_receipts, checked_receipt
from sabre.models import DomainError


def receipt(work_id="work-fixture", project_id="project-fixture", revision=1, **overrides):
    return {
        "version": 1, "policy": "bounded_reads_v1", "work_id": work_id, "project_id": project_id,
        "plan_revision": revision, "role": "developer", "child_id": f"{work_id}/r{revision}/developer/" + "a" * 64,
        "original_digest": "b" * 64, "sent_digest": "c" * 64,
        "original_bytes": 20000, "sent_bytes": 3000, "input_limit_bytes": 8000, "compacted_results": 1,
        "references": [{"tool_call_id": "call-one", "tool": "read_file", "response_digest": "d" * 64,
                        "original_bytes": 19000, "reason": "old_read"}],
        **overrides,
    }


@pytest.mark.parametrize("change", [
    {"sent_bytes": 9000}, {"sent_bytes": -1}, {"original_bytes": True}, {"input_limit_bytes": 0},
    {"role": "owner"}, {"child_id": "other-work/r1/developer/" + "a" * 64},
    {"original_digest": "not-a-digest"}, {"compacted_results": 2},
    {"references_truncated": True}, {"prompt": "synthetic-private-content"},
])
def test_receipts_reject_unbounded_inconsistent_or_content_bearing_fields_without_echo(change):
    with pytest.raises(DomainError) as error:
        checked_receipt(receipt(**change))
    assert error.value.code == "CONTEXT_RECEIPT_INVALID"
    assert "synthetic-private-content" not in str(error.value)


def test_reference_contract_rejects_actions_arguments_and_unbounded_lists():
    original = receipt()
    for change in ({"tool": "edit_source"}, {"tool": "record_note"}, {"reason": "old_read_and_more"},
                   {"args": {"path": "private"}}, {"tool_call_id": "call\ninvalid"}):
        modified = deepcopy(original)
        modified["references"][0].update(change)
        with pytest.raises(DomainError):
            checked_receipt(modified)
    # Command output and write content are archived too; references stay content-free.
    for change in ({"tool": "execute", "reason": "old_output"}, {"tool": "write_file", "reason": "old_argument"},
                   {"tool": "read_context", "reason": "old_page"}):
        modified = deepcopy(original)
        modified["references"][0].update(change)
        assert checked_receipt(modified).references[0].tool == change["tool"]
    modified = deepcopy(original)
    modified["references"] *= 129
    modified["compacted_results"] = 129
    with pytest.raises(DomainError):
        checked_receipt(modified)


@pytest.mark.parametrize("scope", [
    SimpleNamespace(id="foreign-work", project_id="project-fixture", plan_revision=1),
    SimpleNamespace(id="work-fixture", project_id="foreign-project", plan_revision=1),
    SimpleNamespace(id="work-fixture", project_id="project-fixture", plan_revision=2),
])
def test_receipt_requires_the_authorized_work_project_and_revision(scope):
    with pytest.raises(DomainError) as error:
        checked_receipt(receipt(), scope)
    assert error.value.code == "CONTEXT_RECEIPT_SCOPE"


def test_receipt_coverage_is_explicit_and_legacy_context_remains_unknown():
    assert aggregate_receipts([None, None], "work-fixture") is None
    values = [None, receipt(restored_pages=None), receipt(restored_pages=2, compacted_results=130, references_truncated=True)]
    report = aggregate_receipts(values, "work-fixture")
    assert (report.requests_with_context, report.requests_without_context) == (2, 1)
    assert (report.original_bytes, report.sent_bytes, report.compacted_results) == (40000, 6000, 131)
    assert report.restored_pages == 2 and report.requests_with_restored_pages == 1 and report.references_truncated
    assert report.policies[0].model_dump() == {"version": 1, "policy": "bounded_reads_v1", "input_limit_bytes": 8000}
    assert aggregate_receipts([receipt()], "work-fixture").restored_pages is None
    assert aggregate_receipts([receipt(restored_pages=0)], "work-fixture").restored_pages == 0
    with pytest.raises(DomainError):
        aggregate_receipts([receipt()], "another-work")


def test_mutated_model_instances_are_revalidated_before_reservation():
    value = ContextReceipt.model_validate(receipt())
    value.sent_bytes = 100000
    with pytest.raises(DomainError):
        checked_receipt(value)
    value = ContextReceipt.model_validate(receipt())
    value.references[0].original_bytes = -1
    with pytest.raises(DomainError):
        checked_receipt(value)


def test_model_selection_receipts_are_optional_for_legacy_and_reject_unknown_providers():
    assert checked_receipt(receipt()).model_provider is None
    selection = checked_receipt(receipt(model_provider="claude_cli", model_name="sonnet", model_configuration_revision=2))
    assert selection.model_name == "sonnet" and selection.model_configuration_revision == 2
    for change in ({"model_provider": "unreviewed"}, {"model_name": "private\ncontent"}, {"model_configuration_revision": -1}):
        with pytest.raises(DomainError):
            checked_receipt(receipt(**change))
