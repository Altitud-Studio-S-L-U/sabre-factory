"""Real scanner acceptance against clean and deliberately unsafe local fixtures."""

import asyncio
import json
from pathlib import Path
from uuid import uuid4

from sabre.executor import DockerBroker, snapshot_digest
from sabre.models import DomainError, Project
from sabre.security import SecurityService


async def assess(files, expected_categories):
    broker = DockerBroker(Path("/tmp/sabre-scanner-acceptance"))  # noqa: S108 - owned disposable test container
    work_id = "security-" + str(uuid4())
    project = Project(name="security fixture", repository="https://github.com/example/fixture", profile="python", gate_commands=[["python", "-m", "unittest"]])
    entries = [{"path": name, "content": content, "encoding": "utf-8", "executable": False} for name, content in files.items()]
    initial = {"files": entries, "digest": snapshot_digest(entries)}
    broker._install_snapshot(work_id, initial)
    try:
        await broker._persist_workspace(work_id)
        broker._atomic_json(broker._metadata_path(work_id), {"project": project.model_dump(mode="json"), "base_commit": "c" * 40})
        broker.restored.add(work_id)
        report = await SecurityService(broker).review(work_id, initial["digest"], [])
        categories = {finding.category for finding in report.findings}
        assert "scanner_error" not in categories, report.model_dump_json()
        assert expected_categories <= categories, report.model_dump_json()
        assert report.blocked is bool(expected_categories)
        assert report.rules_version == await broker.security_version(work_id)
        try:
            await broker.scan_snapshot(work_id, "0" * 64, [])
        except DomainError as error:
            assert error.code == "STALE_SNAPSHOT"
        else:
            raise AssertionError("A stale snapshot was accepted")
        print(json.dumps({"blocked": report.blocked, "categories": sorted(categories), "findings": len(report.findings), "rules_version": report.rules_version}))
    finally:
        broker._remove_workspace_volume(work_id)
        broker._metadata_path(work_id).unlink(missing_ok=True)
        broker._snapshot_path(work_id).unlink(missing_ok=True)


async def main():
    await assess({"app.py": "def add(a, b):\n    return a + b\n"}, set())
    synthetic = "ghp_" + "aA0bB1cC2dD3eE4fF5gG6hH7iI8jJ9kK0lL1"
    await assess({
        "unsafe.py": "eval(user_input)  # nosemgrep\n",
        "settings.py": f"token = '{synthetic}'  # gitleaks:allow\n",
        "requirements.txt": "Django==1.2\n",
        ".semgrepignore": "*.py\n",
        ".gitleaks.toml": 'title="untrusted"\n[allowlist]\nregexes=[".*"]\n',
        ".trivyignore": "CVE-*\n",
    }, {"secret", "code", "vulnerability"})


if __name__ == "__main__":
    asyncio.run(main())
