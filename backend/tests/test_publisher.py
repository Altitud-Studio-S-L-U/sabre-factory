import json

import httpx
import pytest

from sabre.models import Budget, DeliveryEvidence, DomainError, GateResult, Project, WorkOrder
from sabre.publisher import GitHubPublisher, github_repository
from sabre.repository import digest
from sabre.security import security_policy_digest


class Receipts:
    def __init__(self):
        self.effect = None

    async def get_effect(self, key):
        return self.effect

    async def begin_effect(self, key, request):
        if self.effect is None:
            self.effect = {"state": "pending", "request_hash": digest(request), "result": None}
        if self.effect["request_hash"] != digest(request):
            raise DomainError("EFFECT_CONFLICT", "The effect is bound to another request")
        return self.effect

    async def finish_effect(self, key, result):
        self.effect.update(state="completed", result=result)

    async def security_exceptions(self, work_id):
        return []


async def test_lost_pr_response_is_reconciled_instead_of_creating_another():
    commit = "b" * 40
    work = WorkOrder(project_id="p", mode="patch", objective="Fix calculation", acceptance=["Correct"], budget=Budget(max_cost_usd=1), idempotency_key="idempotent-test")
    work.evidence = DeliveryEvidence(commit=commit, snapshot_digest="a" * 64, profile_digest="c" * 64, rules_version="v1", gates=[GateResult(command=["python", "-m", "unittest"], exit_code=0, output_digest="d" * 64, snapshot_digest="a" * 64)], findings=[], review="Approved")
    project = Project(id="p", name="Example", repository="https://github.com/owner/project", profile="python", gate_commands=[["python", "-m", "unittest"]])
    work.evidence.security_policy_digest = security_policy_digest(work.id, work.evidence.snapshot_digest, work.evidence.rules_version, [], [])
    remote = {"ref": False, "pr": None, "creations": 0, "base": "e" * 40, "base_reads": 0}

    async def handle(request):
        if request.url.path.endswith("/git/ref/heads/main"):
            remote["base_reads"] += 1
            return httpx.Response(200, json={"object": {"sha": remote["base"]}})
        if "/git/ref/heads/" in request.url.path:
            return httpx.Response(200, json={"object": {"sha": commit}}) if remote["ref"] else httpx.Response(404)
        if request.url.path.endswith("/git/refs"):
            assert json.loads(request.content)["ref"] == f"refs/heads/fix/sabre-{work.id}/r1"
            remote["ref"] = True
            return httpx.Response(201, json={})
        if request.method == "GET":
            return httpx.Response(200, json=[remote["pr"]] if remote["pr"] else [])
        remote["creations"] += 1
        remote["pr"] = {"head": {"sha": commit}, "draft": True, "html_url": "https://github.com/owner/project/pull/12"}
        remote["base"] = "f" * 40
        raise httpx.ReadTimeout("Response lost", request=request)

    async with httpx.AsyncClient(transport=httpx.MockTransport(handle), base_url="https://api.github.com") as client:
        publisher = GitHubPublisher(Receipts(), "test-token", client)
        with pytest.raises(httpx.ReadTimeout):
            await publisher.publish(work, project, expected_base="e" * 40)
        result = await publisher.publish(work, project, expected_base="e" * 40)
        assert result["pr_url"].endswith("/12")
        assert result["branch"] == f"fix/sabre-{work.id}/r1"
        assert remote["creations"] == 1
        assert remote["base_reads"] == 1


@pytest.mark.parametrize("url", ["https://github.com.evil.test/owner/repo", "https://token@github.com/owner/repo", "file:///tmp/repo", "https://github.com/owner/repo?token=secret"])
def test_repository_url_cannot_redirect_credentials(url):
    with pytest.raises(DomainError):
        github_repository(url)


@pytest.mark.parametrize(("mode", "kind"), [("create", "feat"), ("patch", "fix"), ("maintain", "chore")])
async def test_commit_uses_the_tree_object_and_preserves_excluded_tracked_dependencies(mode, kind):
    base_commit, base_tree = "a" * 40, "b" * 40
    work = WorkOrder(project_id="p", mode=mode, objective="Update calculation", acceptance=["Correct"], budget=Budget(max_cost_usd=1), idempotency_key="commit-tree-test")
    project = Project(id="p", name="Example", repository="https://github.com/owner/project", profile="python", gate_commands=[["python", "-m", "unittest"]])
    tree_requests = []
    commit_requests = []

    async def handle(request):
        if "/git/ref/heads/" in request.url.path:
            return httpx.Response(200, json={"object": {"sha": base_commit}})
        if request.method == "GET":
            return httpx.Response(200, json={"sha": base_tree, "tree": [
                {"path": "removed.py", "type": "blob", "mode": "100644", "sha": "old"},
                {"path": ".sabre-deps/tracked", "type": "blob", "mode": "100644", "sha": "kept"},
            ]})
        if request.url.path.endswith("/git/trees"):
            tree_requests.append(json.loads(request.content))
        if request.url.path.endswith("/git/commits"):
            commit_requests.append(json.loads(request.content))
        return httpx.Response(201, json={"sha": "c" * 40})

    async with httpx.AsyncClient(transport=httpx.MockTransport(handle), base_url="https://api.github.com") as client:
        await GitHubPublisher(Receipts(), "test-token", client).prepare_commit(work, project, {
            "base_commit": base_commit, "files": [{"path": "app.py", "content": "print('ok')", "executable": True}],
        })
    assert tree_requests[0]["base_tree"] == base_tree
    assert commit_requests[0]["author"] == commit_requests[0]["committer"]
    assert commit_requests[0]["message"].splitlines()[0] == f"{kind}: Update calculation"
    assert tree_requests[0]["tree"] == [
        {"path": "app.py", "mode": "100755", "type": "blob", "sha": "c" * 40},
        {"path": "removed.py", "mode": "100644", "type": "blob", "sha": None},
    ]


def delivery_fixture(mode="patch"):
    project = Project(id="p", name="Fixture", repository="https://github.com/owner/project", profile="python", gate_commands=[["python", "-m", "unittest"]])
    work = WorkOrder(project_id=project.id, mode=mode, objective="Update calculation", acceptance=["Correct result"], budget=Budget(max_cost_usd=1), idempotency_key="branch-contract-fixture")
    work.evidence = DeliveryEvidence(commit="b" * 40, snapshot_digest="a" * 64, profile_digest="c" * 64, rules_version="v1", gates=[GateResult(command=project.gate_commands[0], exit_code=0, output_digest="d" * 64, snapshot_digest="a" * 64)], findings=[], review="Approved")
    work.evidence.security_policy_digest = security_policy_digest(work.id, work.evidence.snapshot_digest, work.evidence.rules_version, [], [])
    return work, project


@pytest.mark.parametrize(("mode", "kind"), [("create", "feat"), ("patch", "fix"), ("maintain", "chore")])
async def test_new_delivery_uses_conventional_branch_without_changing_base(mode, kind):
    work, project = delivery_fixture(mode)
    expected = f"{kind}/sabre-{work.id}/r1"
    writes = []

    async def handle(request):
        if request.method == "POST":
            body = json.loads(request.content)
            writes.append((request.url.path, body))
            return httpx.Response(201, json={"html_url": "https://github.com/owner/project/pull/1"})
        if request.url.path.endswith("/git/ref/heads/main"):
            return httpx.Response(200, json={"object": {"sha": "e" * 40}})
        if request.url.path.endswith("/pulls"):
            assert request.url.params["head"] == f"owner:{expected}"
            return httpx.Response(200, json=[])
        assert request.url.path.endswith(f"/git/ref/heads/{expected}")
        return httpx.Response(404)

    async with httpx.AsyncClient(transport=httpx.MockTransport(handle), base_url="https://api.github.com") as client:
        result = await GitHubPublisher(Receipts(), "test-token", client).publish(work, project, expected_base="e" * 40)
    assert result["branch"] == expected
    assert len(writes) == 2
    assert writes[0][1] == {"ref": f"refs/heads/{expected}", "sha": work.evidence.commit}
    assert writes[1][1]["head"] == expected
    assert writes[1][1]["base"] == "main"
    assert writes[1][1]["draft"] is True


@pytest.mark.parametrize(("completed", "remote_pr"), [(False, False), (False, True), (True, True)])
async def test_legacy_effect_keeps_its_branch_when_resumed(completed, remote_pr):
    work, project = delivery_fixture()
    branch = f"sabre/{work.id}/r1"
    key = f"{work.id}/1/publish"
    receipts = Receipts()
    await receipts.begin_effect(key, {"repo": "owner/project", "branch": branch, "commit": work.evidence.commit})
    expected = {"branch": branch, "pr_url": "https://github.com/owner/project/pull/1", "commit": work.evidence.commit}
    if completed:
        await receipts.finish_effect(key, expected)
    original_hash = receipts.effect["request_hash"]
    writes = []

    async def handle(request):
        assert not completed, "Completed effects must not repeat network operations"
        if request.method == "POST":
            body = json.loads(request.content)
            writes.append(body)
            return httpx.Response(201, json={"html_url": expected["pr_url"]})
        if request.url.path.endswith("/git/ref/heads/main"):
            return httpx.Response(200, json={"object": {"sha": "e" * 40}})
        if request.url.path.endswith("/pulls"):
            assert request.url.params["head"] == f"owner:{branch}"
            return httpx.Response(200, json=[{"head": {"sha": work.evidence.commit}, "draft": True, "state": "open", "html_url": expected["pr_url"]}] if remote_pr else [])
        assert request.url.path.endswith(f"/git/ref/heads/{branch}")
        return httpx.Response(200, json={"object": {"sha": work.evidence.commit}}) if remote_pr else httpx.Response(404)

    async with httpx.AsyncClient(transport=httpx.MockTransport(handle), base_url="https://api.github.com") as client:
        result = await GitHubPublisher(receipts, "test-token", client).publish(work, project, expected_base="e" * 40)
    assert result == expected
    assert receipts.effect["request_hash"] == original_hash
    assert len(writes) == (0 if remote_pr else 2)
    if writes:
        assert writes[0]["ref"] == f"refs/heads/{branch}"
        assert writes[1]["head"] == branch


@pytest.mark.parametrize("changed", [{"repo": "owner/another"}, {"commit": "f" * 40}])
async def test_changed_effect_binding_blocks_before_github_requests(changed):
    work, project = delivery_fixture()
    receipts = Receipts()
    await receipts.begin_effect(f"{work.id}/1/publish", {"repo": "owner/project", "branch": f"sabre/{work.id}/r1", "commit": work.evidence.commit, **changed})

    async def handle(request):
        pytest.fail("An unrelated effect must not contact GitHub")

    async with httpx.AsyncClient(transport=httpx.MockTransport(handle), base_url="https://api.github.com") as client:
        with pytest.raises(DomainError) as error:
            await GitHubPublisher(receipts, "test-token", client).publish(work, project, expected_base="e" * 40)
    assert error.value.code == "EFFECT_CONFLICT"
