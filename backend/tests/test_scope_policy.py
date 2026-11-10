import json
from types import SimpleNamespace
from unittest.mock import AsyncMock

from sabre.artifacts import ArtifactStore
from sabre.models import Budget, WorkOrder
from sabre.security import SecretGuard
from sabre.workflows import Factory


async def test_material_permission_is_bound_to_exact_manifests_even_when_prompt_is_unchanged(tmp_path):
    guard = SecretGuard()
    artifacts = ArtifactStore(tmp_path, guard)
    baseline = artifacts.put(json.dumps({"package.json": '{"dependencies":{"react":"1.2.3"}}'}))
    work = WorkOrder(project_id="project-one", mode="patch", objective="Corregir el comportamiento", acceptance=["Pasa la regresión"], budget=Budget(max_cost_usd=1), idempotency_key="scope-policy-test")
    current = {"files": [{"path": "package.json", "content": '{"dependencies":{"react":"2.0.0"}}'}]}

    async def begin(state, phase):
        return WorkOrder.model_validate(state["order"])

    async def finish(order):
        return {"order": order.model_dump(mode="json")}

    factory = SimpleNamespace(begin=begin, finish=finish, artifacts=artifacts, executor=SimpleNamespace(snapshot=AsyncMock(side_effect=lambda _: current)))
    state = {"order": work.model_dump(mode="json"), "baseline_manifests": baseline}
    first = await Factory.scope_guard(factory, state)
    first_question = first["order"]["questions"][0]
    first_question["answer"] = "Aprobar"
    state["order"] = first["order"]

    unchanged = await Factory.scope_guard(factory, state)
    assert len(unchanged["order"]["questions"]) == 1
    current["files"][0]["content"] = '{"dependencies":{"react":"3.0.0"}}'
    changed = await Factory.scope_guard(factory, state)
    questions = changed["order"]["questions"]
    assert len(questions) == 2
    assert questions[0]["prompt"] == questions[1]["prompt"]
    assert questions[0]["subject_digest"] != questions[1]["subject_digest"]
    assert questions[1]["answer"] is None
