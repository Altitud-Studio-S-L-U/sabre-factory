"""Owner-local projections of actual Supervisor tool records in LangGraph."""

import json

from langchain_core.messages import AIMessage, HumanMessage, ToolMessage
from pydantic import ValidationError

from sabre.inspection import safe_text, visible_text
from sabre.models import DomainError
from sabre.operator_contracts import OperatorToolTrace, OperatorToolTracePage
from sabre.operator_readiness import FactoryReadinessView, navigation_actions


def recorded_tools(messages, message_id, guard, checkpoint_id=None):
    result = OperatorToolTracePage(message_id=message_id, available=False, checkpoint_id=checkpoint_id)
    calls: dict[str, OperatorToolTrace] = {}
    # A bounded inspection must not disclose another owner's message segment.
    material = messages[-2000:]
    result.truncated = len(messages) > len(material)
    for message in material:
        if isinstance(message, HumanMessage):
            if result.available:
                break
            if message.id == message_id:
                result.available = True
            continue
        if not result.available:
            continue
        if isinstance(message, AIMessage):
            for call in message.tool_calls:
                if len(calls) >= 50:
                    result.truncated = True
                    break
                identifier = str(call.get("id", ""))
                if identifier in calls:
                    continue
                name, name_redacted, name_truncated = safe_text(str(call.get("name", "unknown")), guard)
                content, redacted, truncated = safe_text(call.get("args", {}), guard)
                row = OperatorToolTrace(call_id=identifier, name=name[:128], input=content,
                    status="pending", redacted=redacted or name_redacted,
                    truncated=truncated or name_truncated or len(name) > 128)
                calls[identifier] = row
                result.tools.append(row)
        elif isinstance(message, ToolMessage) and message.tool_call_id in calls:
            row = calls[message.tool_call_id]
            row.output, redacted, truncated = safe_text(visible_text(message.content) if message.content != [] else "[]", guard)
            row.redacted = row.redacted or redacted
            row.truncated = row.truncated or truncated
            row.status = "error" if message.status == "error" else "completed"
            if row.name == "get_factory_readiness":
                result.actions = []
                raw = visible_text(message.content)
                if row.status == "completed" and not row.redacted and len(raw) <= 65536:
                    try:
                        guard.check(raw)
                        readiness = FactoryReadinessView.model_validate(json.loads(raw))
                        result.actions = navigation_actions(readiness)
                    except (DomainError, ValidationError, ValueError):
                        pass
    return result


async def inspect_operator_tools(service, message_id):
    row = await service.queue.operator_conversation.get(message_id)
    if row is None:
        raise DomainError("OPERATOR_MESSAGE_NOT_FOUND", "The supervisor message does not exist", 404)
    work_id = row["data"].get("work_id")
    scope = f"operator:owner:run:{work_id}" if work_id else "operator:owner:factory"
    checkpointer = service.factory.team.checkpointer
    if checkpointer is None:
        return OperatorToolTracePage(message_id=message_id, available=False)
    saved = await checkpointer.aget_tuple({"configurable": {"thread_id": scope}})
    if saved is None:
        return OperatorToolTracePage(message_id=message_id, available=False)
    return recorded_tools(saved.checkpoint.get("channel_values", {}).get("messages", []), message_id,
        service.guard, str(saved.checkpoint.get("id", "")) or None)
