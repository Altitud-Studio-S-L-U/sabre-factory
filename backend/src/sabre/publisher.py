"""GitHub effects are isolated from the model and reconciled by their bound branch and commit."""

import base64
import re

import httpx

from sabre.models import DomainError, Project, WorkOrder
from sabre.repository import digest
from sabre.security import is_blocking_finding, security_policy_digest

CHANGE_TYPES = {"create": "feat", "patch": "fix", "maintain": "chore"}


def validate_commit_message(message: str):
    if not re.fullmatch(r"(?:feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(?:\([a-z0-9][a-z0-9._/-]*\))?!?: [^\r\n]+(?:\n\n[\s\S]*)?", message) or any(ord(char) < 32 and char != "\n" for char in message) or not message.splitlines()[0].split(": ", 1)[1].strip():
        raise DomainError("INVALID_COMMIT_MESSAGE", "Delivery requires a Conventional Commit with a non-empty subject", 422)
    return message


def github_repository(url: str) -> str:
    match = re.fullmatch(r"https://github\.com/([A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+?)(?:\.git)?/?", url)
    if not match or ".." in match[1].split("/"):
        raise DomainError("REPOSITORY_NOT_ALLOWED", "Use the HTTPS URL of an authorized GitHub repository", 422)
    return match[1]


class GitHubPublisher:
    def __init__(self, repository, token: str, client: httpx.AsyncClient | None = None, *, token_resolver=None):
        self.repository = repository
        self.token = token
        self.client = client
        self.token_resolver = token_resolver

    async def request(self, method: str, path: str, **kwargs):
        token = (await self.token_resolver()).get_secret_value() if self.token_resolver else self.token
        if not token:
            raise DomainError("GITHUB_NOT_CONFIGURED", "Configure SABRE access to GitHub")
        headers = {"Authorization": f"Bearer {token}", "Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28"}
        extra_headers = kwargs.pop("headers", {})
        if set(extra_headers) - {"Content-Type"}:
            raise DomainError("GITHUB_HEADERS_NOT_ALLOWED", "Only the fixed content type may extend GitHub request headers", 422)
        headers.update(extra_headers)
        if self.client:
            response = await self.client.request(method, path, headers=headers, **kwargs)
        else:
            async with httpx.AsyncClient(base_url="https://api.github.com", timeout=30) as client:
                response = await client.request(method, path, headers=headers, **kwargs)
        if response.status_code == 404:
            return None
        if response.is_error:
            raise DomainError("GITHUB_ERROR", f"GitHub rejected the operation ({response.status_code})")
        return response.json()

    async def validate_base(self, project: Project, expected_commit: str):
        repo = github_repository(project.repository)
        base = await self.request("GET", f"/repos/{repo}/git/ref/heads/{project.default_branch}")
        if not base or base["object"]["sha"] != expected_commit:
            raise DomainError("BASE_CHANGED", "The base branch changed; update the plan and verify again")

    async def validate_policy(self, work: WorkOrder, project: Project):
        evidence = work.evidence
        if not evidence:
            raise DomainError("EVIDENCE_REQUIRED", "Reviewed evidence is missing")
        actual = security_policy_digest(work.id, evidence.snapshot_digest, evidence.rules_version,
            project.approved_baseline, await self.repository.security_exceptions(work.id), plan_revision=work.plan_revision)
        if actual != evidence.security_policy_digest:
            raise DomainError("SECURITY_POLICY_CHANGED", "The policy changed or expired before publication")

    async def prepare_commit(self, work: WorkOrder, project: Project, snapshot: dict) -> str:
        if work.mode not in CHANGE_TYPES:
            raise DomainError("DELIVERY_NOT_AUTHORIZED", "This work mode cannot create a delivery commit", 403)
        message = validate_commit_message(f"{CHANGE_TYPES[work.mode]}: {work.objective.splitlines()[0][:100]}\n\nSABRE work: {work.id}; revision: {work.plan_revision}")
        repo = github_repository(project.repository)
        await self.validate_base(project, snapshot["base_commit"])
        tree = await self.request("GET", f"/repos/{repo}/git/trees/{snapshot['base_commit']}", params={"recursive": "1"})
        if not tree or tree.get("truncated"):
            raise DomainError("TREE_INCOMPLETE", "Cannot verify the complete repository tree")
        files = {f["path"]: f for f in snapshot["files"]}
        entries = []
        for path, file in sorted(files.items()):
            content = file["content"]
            if file.get("encoding") != "base64":
                content = base64.b64encode(content.encode()).decode()
            blob = await self.request("POST", f"/repos/{repo}/git/blobs", json={"content": content, "encoding": "base64"})
            entries.append({"path": path, "mode": "100755" if file.get("executable") else "100644", "type": "blob", "sha": blob["sha"]})
        for item in tree["tree"]:
            dependency_path = any(part in {"node_modules", ".venv", "__pycache__", ".pytest_cache", ".ruff_cache", ".mypy_cache", ".sabre-deps", ".git"} for part in item["path"].split("/"))
            if item["type"] == "blob" and item["path"] not in files and not dependency_path:
                entries.append({"path": item["path"], "mode": item["mode"], "type": "blob", "sha": None})
        new_tree = await self.request("POST", f"/repos/{repo}/git/trees", json={"base_tree": tree["sha"], "tree": entries})
        commit = await self.request("POST", f"/repos/{repo}/git/commits", json={
            "message": message,
            "tree": new_tree["sha"], "parents": [snapshot["base_commit"]],
            "author": {"name": "SABRE", "email": "sabre@users.noreply.github.com", "date": work.created_at.isoformat()},
            "committer": {"name": "SABRE", "email": "sabre@users.noreply.github.com", "date": work.created_at.isoformat()},
        })
        return commit["sha"]

    async def publish(self, work: WorkOrder, project: Project, *, expected_base: str) -> dict:
        evidence = work.evidence
        if not evidence or not evidence.commit or not evidence.gates or any(g.exit_code or g.snapshot_digest != evidence.snapshot_digest for g in evidence.gates):
            raise DomainError("EVIDENCE_REQUIRED", "Delivery requires approved evidence")
        if any(is_blocking_finding(f) for f in evidence.findings):
            raise DomainError("SECURITY_BLOCKED", "Delivery has blocking security findings")
        repo = github_repository(project.repository)
        branch = f"{CHANGE_TYPES[work.mode]}/sabre-{work.id}/r{work.plan_revision}"
        key = f"{work.id}/{work.plan_revision}/publish"
        request = {"repo": repo, "branch": branch, "commit": evidence.commit}
        prior = await self.repository.get_effect(key)
        if prior and prior["request_hash"] != digest(request):
            # An uncertain older publication must reconcile its original remote branch.
            legacy = {**request, "branch": f"sabre/{work.id}/r{work.plan_revision}"}
            if prior["request_hash"] != digest(legacy):
                raise DomainError("EFFECT_CONFLICT", "The operation is bound to other data")
            request, branch = legacy, legacy["branch"]
        receipt = await self.repository.begin_effect(key, request)
        if receipt["state"] == "completed":
            return receipt["result"]
        ref = await self.request("GET", f"/repos/{repo}/git/ref/heads/{branch}")
        if ref and ref["object"]["sha"] != evidence.commit:
            raise DomainError("DELIVERY_CONFLICT", "The delivery branch contains another commit")
        prs = await self.request("GET", f"/repos/{repo}/pulls", params={"head": f"{repo.split('/')[0]}:{branch}", "state": "all"})
        if prs:
            pr = prs[0]
            head, base = pr.get("head", {}), pr.get("base", {})
            def same_repository(value):
                return isinstance(value, str) and value.casefold() == repo.casefold()
            if head.get("sha") != evidence.commit or head.get("ref") != branch or pr.get("draft") is not True or pr.get("state") != "open" or base.get("ref") != project.default_branch or not same_repository(base.get("repo", {}).get("full_name")) or ("repo" in head and (not isinstance(head["repo"], dict) or not same_repository(head["repo"].get("full_name")))):
                raise DomainError("DELIVERY_CONFLICT", "The existing PR does not match the reviewed delivery")
        else:
            await self.validate_base(project, expected_base)
            if not ref:
                await self.validate_policy(work, project)
                await self.request("POST", f"/repos/{repo}/git/refs", json={"ref": f"refs/heads/{branch}", "sha": evidence.commit})
            body = "## Scope\n\n" + work.objective + "\n\n## Acceptance\n\n" + "\n".join("- " + item for item in work.acceptance) + "\n\n## Verification\n\n"
            body += f"Commit: `{evidence.commit}`\n\nSnapshot: `{evidence.snapshot_digest}`\n\n"
            body += "\n".join(f"- {' '.join(g.command)}: exit {g.exit_code}, artifact `{g.output_digest}`" for g in evidence.gates)
            body += "\n\n## Review\n\n" + evidence.review
            body += "\n\n## Constraints and limitations\n\n" + ("\n".join("- " + item for item in work.constraints) if work.constraints else "No additional run constraints were recorded.")
            body += "\n\nThis draft contains the recorded checks for the exact snapshot above. Merge, deployment and release publication require separate authorization."
            await self.validate_policy(work, project)
            pr = await self.request("POST", f"/repos/{repo}/pulls", json={"head": branch, "base": project.default_branch,
                "title": f"[{work.mode}] {work.objective.splitlines()[0][:180]}", "body": body, "draft": True})
        result = {"branch": branch, "pr_url": pr["html_url"], "commit": evidence.commit}
        await self.repository.finish_effect(key, result)
        return result
