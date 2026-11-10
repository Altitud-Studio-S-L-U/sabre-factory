"""Registry-proxy acceptance for uv, npm and pnpm; no provider credentials."""

import asyncio
import json
from pathlib import Path
from uuid import uuid4

from sabre.executor import DockerBroker, snapshot_digest
from sabre.models import Project


async def check(profile, manager, files, gate):
    broker = DockerBroker(Path("/tmp/sabre-dependency-acceptance"))  # noqa: S108 - owned disposable test container
    work_id = "dependencies-" + str(uuid4())
    project = Project(name=manager + " acceptance", repository="https://github.com/example/fixture", profile=profile, gate_commands=[gate])
    entries = [{"path": path, "content": content, "encoding": "utf-8", "executable": False} for path, content in files.items()]
    broker._install_snapshot(work_id, {"files": entries, "digest": snapshot_digest(entries)})
    try:
        await broker._persist_workspace(work_id)
        broker._atomic_json(broker._metadata_path(work_id), {"project": project.model_dump(mode="json"), "base_commit": "b" * 40})
        broker.restored.add(work_id)
        resolved = await broker.resolve_dependencies(work_id)
        await broker.prepare_dependencies(work_id)
        snapshot = await broker.snapshot(work_id)
        assert snapshot["digest"] == resolved["snapshot_digest"]
        result = await broker.execute_gate(work_id, gate, snapshot["digest"])
        assert result.exit_code == 0, result.output
        print(json.dumps({"manager": manager, "locks": resolved["locks"], "gate_exit": result.exit_code, "snapshot": snapshot["digest"]}))
    finally:
        broker._remove_workspace_volume(work_id)
        broker._metadata_path(work_id).unlink(missing_ok=True)
        broker._snapshot_path(work_id).unlink(missing_ok=True)


async def main():
    await check("python", "uv", {
        "pyproject.toml": '[project]\nname="fixture"\nversion="0.1.0"\nrequires-python=">=3.14"\ndependencies=["six==1.17.0"]\n',
        "test_dependency.py": 'import unittest\nimport six\nclass Dependency(unittest.TestCase):\n    def test_six(self):\n        self.assertEqual(six.__version__, "1.17.0")\n',
    }, ["python", "-m", "unittest", "discover", "-q"])
    for manager in ("npm", "pnpm"):
        manifest = {"name": "fixture", "version": "1.0.0", "private": True, "dependencies": {"is-number": "7.0.0"}}
        if manager == "pnpm":
            manifest["packageManager"] = "pnpm@11.19.0"
        await check("node", manager, {
            "package.json": json.dumps(manifest),
            "test.js": "const test=require('node:test');const assert=require('node:assert/strict');const isNumber=require('is-number');test('dependency',()=>assert.equal(isNumber(42),true));\n",
            ".pnpmfile.cjs": "throw new Error('Untrusted metadata hook must never execute');\n",
        }, ["node", "--test"])


if __name__ == "__main__":
    asyncio.run(main())
