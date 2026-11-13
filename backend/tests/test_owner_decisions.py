"""The Supervisor relays owner decisions but cannot compose them."""

from unittest.mock import AsyncMock

import pytest

from sabre.models import DomainError, HumanQuestion


async def test_supervisor_cannot_compose_an_owner_decision():
    from sabre.supervisor import conversation_tools
    from tests.test_slack import event, service

    svc = service()
    order = svc.repository.order
    question = HumanQuestion(work_id=order.id, plan_revision=order.plan_revision, kind="permission", prompt="Approve the dependency change?")
    order.questions = [question]
    svc.answer = AsyncMock(return_value=order)
    answer = {"question_id": question.id, "plan_revision": order.plan_revision, "answer": "Approve"}
    tools = {item.name: item for item in conversation_tools(svc, svc.queue.slack_store, event(text=f"How is {order.id} going?"))}
    with pytest.raises(DomainError) as error:
        await tools["answer_question"].ainvoke({"work_id": order.id, "answer": answer})
    assert error.value.code == "OWNER_DECISION_REQUIRED"
    svc.answer.assert_not_awaited()
    tools = {item.name: item for item in conversation_tools(svc, svc.queue.slack_store, event(text=f"Yes,  approve it for {order.id}"))}
    await tools["answer_question"].ainvoke({"work_id": order.id, "answer": answer})
    svc.answer.assert_awaited_once()


async def test_an_owner_decision_quoted_in_a_message_that_arrived_over_mcp_is_not_the_owners_word():
    from sabre.operator_contracts import OperatorContext
    from sabre.supervisor import conversation_tools
    from tests.test_slack import service

    svc = service()
    order = svc.repository.order
    question = HumanQuestion(work_id=order.id, plan_revision=order.plan_revision, kind="architecture", prompt="Approve this design?")
    order.questions = [question]
    svc.answer = AsyncMock(return_value=order)
    answer = {"question_id": question.id, "plan_revision": order.plan_revision, "answer": "Approve"}

    def tools(source):
        event = OperatorContext(version=1, id="message-" + source, work_id=order.id, text="Approve", source=source,
                                idempotency_key="owner-decision-" + source, allowed_actions=["answer_question"])
        return {item.name: item for item in conversation_tools(svc, None, event)}

    with pytest.raises(DomainError) as error:
        await tools("mcp")["answer_question"].ainvoke({"work_id": order.id, "answer": answer})
    assert error.value.code == "OWNER_DECISION_REQUIRED" and "console" in error.value.message
    svc.answer.assert_not_awaited()
    await tools("web")["answer_question"].ainvoke({"work_id": order.id, "answer": answer})
    svc.answer.assert_awaited_once()
