"""Explicit Docker acceptance: run only in an owned test container with the socket.

The API and worker must never receive the daemon socket. This test exercises the
broker itself against real disposable volumes and containers, with local fixtures.
"""

import asyncio
import json
from pathlib import Path
from uuid import uuid4

import docker

from sabre.executor import DockerBroker, snapshot_digest
from sabre.models import DomainError, Project


async def main():
    broker = DockerBroker(Path("/tmp/sabre-runtime-acceptance"))  # noqa: S108 - owned disposable test container
    work_id = "acceptance-" + str(uuid4())
    project = Project(name="runtime acceptance", repository="https://github.com/example/fixture", profile="python",
                      gate_commands=[["python", "-m", "unittest", "discover", "-q"]])
    files = [
        {"path": "calculator.py", "content": "def add(a, b):\n    return a - b\n", "encoding": "utf-8", "executable": False},
        {"path": "test_calculator.py", "content": "import unittest\nfrom calculator import add\nclass Regression(unittest.TestCase):\n    def test_add(self):\n        self.assertEqual(add(2, 3), 5)\n", "encoding": "utf-8", "executable": False},
        {"path": "asset.bin", "content": "AP8Q", "encoding": "base64", "executable": False},
    ]
    initial = {"digest": snapshot_digest(files), "files": files}
    broker._install_snapshot(work_id, initial)
    try:
        await broker._persist_workspace(work_id)
        broker._atomic_json(broker._metadata_path(work_id), {"project": project.model_dump(mode="json"), "base_commit": "a" * 40})
        broker.restored.add(work_id)
        assert (await broker.snapshot(work_id))["digest"] == initial["digest"]
        red = await broker.execute_gate(work_id, project.gate_commands[0], initial["digest"])
        assert red.exit_code != 0
        await broker.write_file(work_id, "calculator.py", "def add(a, b):\n    return a + b\n")
        updated = await broker.snapshot(work_id)
        assert updated["digest"] != initial["digest"]
        green = await broker.execute_gate(work_id, project.gate_commands[0], updated["digest"])
        assert green.exit_code == 0, green.output
        isolation = await broker.execute(work_id, ["python", "-c", "import os,json; print(json.dumps({'socket':os.path.exists('/var/run/docker.sock'),'broker_state':os.path.exists('/workspaces'),'token':any(k in os.environ for k in ['SABRE_EXECUTOR_TOKEN','SABRE_GITHUB_READ_TOKEN','OPENAI_API_KEY','SABRE_AUTH_TOKEN','SABRE_GATEWAY_TOKEN']),'bootstrap_files':os.path.exists('/run/secrets'),'bootstrap_env':any(k in os.environ for k in ['SABRE_BOOTSTRAP_FILE','SABRE_VAULT_MASTER_KEY_FILE']),'workspace_bytes':os.statvfs('/workspace').f_blocks*os.statvfs('/workspace').f_frsize}))"])
        checks = json.loads(isolation.output)
        assert checks == {"socket": False, "broker_state": False, "token": False, "bootstrap_files": False, "bootstrap_env": False, "workspace_bytes": 536870912}
        network = await broker.execute(work_id, ["python", "-c", "import socket\ntry:\n s=socket.create_connection(('1.1.1.1',443),timeout=2); print('unexpected network')\nexcept OSError:\n print('blocked')"])
        assert network.output.strip() == "blocked"
        broker._remove_workspace_volume(work_id)
        restarted = DockerBroker(broker.root)
        assert (await restarted.snapshot(work_id))["digest"] == updated["digest"]
        assert await restarted.read_file(work_id, "calculator.py") == "def add(a, b):\n    return a + b\n"
        orphan = restarted._container(restarted._image("SABRE_PYTHON_IMAGE"), work_id, ["python", "-c", "import time; time.sleep(300)"])
        orphan.start()
        after_broker_crash = DockerBroker(broker.root)
        assert (await after_broker_crash.snapshot(work_id))["digest"] == updated["digest"]
        try:
            after_broker_crash.docker.containers.get(orphan.id)
        except docker.errors.NotFound:
            pass
        else:
            raise AssertionError("An orphan command survived broker recovery")
        try:
            await restarted.read_file(work_id, "../other-project/secret")
        except DomainError as error:
            assert error.code == "UNSAFE_PATH"
        else:
            raise AssertionError("Traversal was accepted")
        print(json.dumps({"red_exit": red.exit_code, "green_exit": green.exit_code, "isolation": checks, "network": "blocked", "restored_digest": updated["digest"], "orphan_recovered": True}))
    finally:
        broker._remove_workspace_volume(work_id)
        broker._metadata_path(work_id).unlink(missing_ok=True)
        broker._snapshot_path(work_id).unlink(missing_ok=True)


if __name__ == "__main__":
    asyncio.run(main())
