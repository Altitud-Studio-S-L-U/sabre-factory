import httpx
import pytest

from sabre.models import DomainError
from sabre.publisher import GitHubPublisher
from tests.test_publisher import Receipts, delivery_fixture


@pytest.mark.parametrize("changed", ["base_branch", "base_repository", "head_repository", "head_branch"])
async def test_recovered_pr_cannot_finish_a_receipt_for_another_delivery_target(changed):
    work, project = delivery_fixture()
    receipts = Receipts()
    writes = []
    pull = {"head": {"ref": f"fix/sabre-{work.id}/r1", "sha": work.evidence.commit, "repo": {"full_name": "owner/project"}},
        "base": {"ref": project.default_branch, "repo": {"full_name": "owner/project"}},
        "state": "open", "draft": True, "html_url": "https://github.com/owner/project/pull/1"}
    if changed == "base_branch":
        pull["base"]["ref"] = "different-target"
    elif changed == "base_repository":
        pull["base"]["repo"]["full_name"] = "owner/different-project"
    elif changed == "head_repository":
        pull["head"]["repo"]["full_name"] = "owner/different-project"
    else:
        pull["head"]["ref"] = "different-head"

    async def remote(request):
        if request.method != "GET":
            writes.append(request)
            raise AssertionError("Unexpected remote mutation")
        if request.url.path.endswith("/pulls"):
            return httpx.Response(200, json=[pull])
        return httpx.Response(200, json={"object": {"sha": work.evidence.commit}})

    async with httpx.AsyncClient(transport=httpx.MockTransport(remote), base_url="https://api.github.com") as http:
        with pytest.raises(DomainError) as error:
            await GitHubPublisher(receipts, "synthetic-token", http).publish(work, project, expected_base="e" * 40)
    assert error.value.code == "DELIVERY_CONFLICT"
    assert receipts.effect["state"] == "pending"
    assert writes == []
