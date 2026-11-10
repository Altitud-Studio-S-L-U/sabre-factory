import json
from types import SimpleNamespace

import pytest
from mcp import Client
from mcp.types import ElicitResult

from sabre.mcp_server import build_mcp
from sabre.models import Answer, Budget, DomainError, HumanQuestion, Project, Status, WorkOrder


async def test_mcp_project_creation_returns_structured_receipt_without_repeating_mutation():
    projects = []

    async def create_project(request):
        project = Project(**request.model_dump())
        projects.append(project)
        return project

    async def list_projects():
        return projects

    service = SimpleNamespace(create_project=create_project, repository=SimpleNamespace(projects=list_projects))
    async with Client(build_mcp(lambda: service)) as client:
        catalog = await client.list_tools()
        response = await client.call_tool("sabre_create_project", {"request": {
            "name": "Synthetic fixture", "repository": "https://github.com/example/fixture", "profile": "node", "gate_commands": [["node", "--test"]],
        }})
        assert not response.is_error
        assert len(projects) == 1
        assert response.structured_content is not None
        receipt = json.loads(json.dumps(response.structured_content))
        assert receipt["id"] == projects[0].id
        listed = await client.call_tool("sabre_list_projects", {})
        assert listed.structured_content == {"result": [receipt]}
        assert len(projects) == 1
        assert all(tool.output_schema is not None for tool in catalog.tools)


def fixture_service():
    work = WorkOrder(project_id="fixture", mode="patch", objective="Correct empty input", acceptance=["Returns zero"],
        budget=Budget(max_cost_usd=1), idempotency_key="native-hitl-test", status=Status.WAITING_INPUT)
    question = HumanQuestion(work_id=work.id, plan_revision=1, prompt="¿Qué salida tiene el caso vacío?", kind="clarification")
    work.questions = [question]
    calls = []

    async def get_work(work_id):
        assert work_id == work.id
        return work

    async def answer(work_id, request: Answer):
        if work.status != Status.WAITING_INPUT or request.question_id != question.id or request.plan_revision != 1:
            raise DomainError("QUESTION_CLOSED", "La pregunta ya no está pendiente")
        calls.append(request)
        question.answer, work.status = request.answer, Status.QUEUED
        return work

    service = SimpleNamespace(repository=SimpleNamespace(work=get_work), answer=answer)
    return service, work, question, calls


@pytest.mark.parametrize("action", ["accept", "decline", "cancel"])
async def test_native_mcp_elicitation_resolves_only_an_accepted_current_question(action):
    service, work, question, calls = fixture_service()
    prompts = []

    async def elicit(context, params):
        prompts.append(params.message)
        return ElicitResult(action=action, content={"answer": "Debe devolver cero"} if action == "accept" else None)

    async with Client(build_mcp(lambda: service), elicitation_callback=elicit) as client:
        tools = await client.list_tools()
        native = next(tool for tool in tools.tools if tool.name == "sabre_resolve_question_native")
        assert "reply" not in native.input_schema["properties"]
        response = await client.call_tool("sabre_resolve_question_native", {"work_id": work.id, "question_id": question.id, "plan_revision": 1})
        assert not response.is_error
    assert prompts == [question.prompt]
    assert len(calls) == (1 if action == "accept" else 0)
    assert work.status == (Status.QUEUED if action == "accept" else Status.WAITING_INPUT)


async def test_native_mcp_rejects_stale_question_before_asking_owner():
    service, work, question, calls = fixture_service()

    async def unexpected(context, params):
        pytest.fail("A stale decision must not reach the owner")

    async with Client(build_mcp(lambda: service), elicitation_callback=unexpected) as client:
        response = await client.call_tool("sabre_resolve_question_native", {"work_id": work.id, "question_id": question.id, "plan_revision": 2})
        assert response.is_error
    assert calls == []


async def test_native_mcp_rejects_question_from_older_plan_even_when_work_revision_matches():
    service, work, question, calls = fixture_service()
    work.plan_revision = 2

    async def unexpected(context, params):
        pytest.fail("A question from an older plan must not reach the owner")

    async with Client(build_mcp(lambda: service), elicitation_callback=unexpected) as client:
        response = await client.call_tool("sabre_resolve_question_native", {"work_id": work.id, "question_id": question.id, "plan_revision": 2})
        assert response.is_error
    assert calls == []
