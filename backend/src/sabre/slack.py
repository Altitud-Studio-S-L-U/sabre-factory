"""Slack ingress is durable; model conversations run in the worker, never in the gateway."""

import asyncio
import os
import re
from contextlib import asynccontextmanager
from typing import Any, Literal
from uuid import NAMESPACE_URL, uuid5

import httpx
from psycopg.types.json import Jsonb
from pydantic import Field, SecretStr, ValidationError, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict
from slack_bolt.adapter.socket_mode.async_handler import AsyncSocketModeHandler
from slack_bolt.async_app import AsyncApp
from slack_sdk.errors import SlackApiError
from slack_sdk.web.async_client import AsyncWebClient

from sabre.error_boundaries import guarded_call
from sabre.models import (
    Contract,
    DomainError,
)
from sabre.private_credentials import fetch_credentials
from sabre.repository import digest, payload
from sabre.run_state import open_questions
from sabre.security import SecretGuard
from sabre.settings import load_bootstrap, reject_secret_environment
from sabre.supervisor import (
    ChatGuard as ChatGuard,
)
from sabre.supervisor import (
    SupervisorConversation as SlackConversation,
)
from sabre.supervisor import (
    conversation_tools as conversation_tools,
)
from sabre.supervisor import (
    explicit_budgets as explicit_budgets,
)

SLACK_SCHEMA = """
CREATE TABLE IF NOT EXISTS sabre_slack_inbox(
 id text PRIMARY KEY, request_hash text NOT NULL, data jsonb NOT NULL,
 state text NOT NULL DEFAULT 'queued', result jsonb,
 received_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS sabre_slack_threads(
 work_id text PRIMARY KEY REFERENCES work_orders(id), channel text NOT NULL, thread_ts text NOT NULL);
"""

STATE_LABELS = {"queued": "queued", "running": "running", "waiting_input": "needs your response", "paused": "paused", "blocked": "blocked", "failed": "failed", "cancelled": "cancelled", "completed": "completed"}
PHASE_LABELS = {"intake": "intake", "analysis": "analysis", "clarification": "clarification", "design": "design", "design_clarification": "design clarification", "architecture_approval": "architecture decision", "planning": "planning", "plan_clarification": "plan clarification", "implementation": "implementation", "task_clarification": "task clarification", "scope_check": "scope check", "scope_approval": "scope decision", "verification": "verification", "qa_clarification": "verification clarification", "review": "review", "review_clarification": "review clarification", "security": "security", "decision": "evaluation", "prepare_delivery": "delivery preparation", "delivery": "delivery", "ready": "ready", "repair": "repair", "security_watch": "security watch"}


class SlackMessage(Contract):
    event_id: str = Field(pattern=r"^[A-Za-z0-9:._-]{8,180}$")
    user: str = Field(pattern=r"^[UW][A-Z0-9]+$")
    channel: str = Field(pattern=r"^D[A-Z0-9]+$")
    channel_type: Literal["im"]
    ts: str = Field(pattern=r"^\d+\.\d+$")
    thread_ts: str | None = Field(default=None, pattern=r"^\d+\.\d+$")
    text: str = Field(min_length=1, max_length=12000)

    @property
    def thread(self):
        return self.thread_ts or self.ts

    @property
    def binding(self):
        return f"{self.channel}/{self.thread}"

    @property
    def conversation_id(self):
        return f"slack-v1:{self.user}:{self.channel}/{self.thread_ts or 'root'}"


class SlackStore:
    def __init__(self, repository):
        self.repository = repository

    async def initialize(self):
        async with self.repository.connection() as conn:
            await conn.execute("SELECT pg_advisory_xact_lock(813779)")
            await conn.execute(SLACK_SCHEMA)

    async def admit(self, event: SlackMessage, task):
        data = payload(event)
        async with self.repository.connection() as conn:
            await conn.execute("SELECT pg_advisory_xact_lock(hashtextextended(%s,3))", (event.event_id,))
            prior = await (await conn.execute("SELECT request_hash FROM sabre_slack_inbox WHERE id=%s", (event.event_id,))).fetchone()
            if prior:
                if prior["request_hash"] != digest(data):
                    raise DomainError("IDEMPOTENCY_CONFLICT", "The event already identifies another message")
                return {"accepted": True, "event_id": event.event_id, "duplicate": True}
            await conn.execute("INSERT INTO sabre_slack_inbox(id,request_hash,data) VALUES(%s,%s,%s)", (event.event_id, digest(data), Jsonb(data)))
            await task.configure(connection=conn, lock=event.conversation_id).defer_async(event_id=event.event_id)
        return {"accepted": True, "event_id": event.event_id, "duplicate": False}

    async def inbox(self, event_id):
        async with self.repository.connection() as conn:
            return await (await conn.execute("SELECT * FROM sabre_slack_inbox WHERE id=%s", (event_id,))).fetchone()

    async def complete(self, event: SlackMessage, reply: str):
        async with self.repository.connection() as conn:
            result = {"message": reply}
            await conn.execute("UPDATE sabre_slack_inbox SET state='completed',result=%s WHERE id=%s", (Jsonb(result), event.event_id))
            data = {"kind": "chat_reply", "message": reply, "channel": event.channel, "thread_ts": event.thread}
            await conn.execute("INSERT INTO notifications(id,work_id,data,delivered) VALUES(%s,NULL,%s,false) ON CONFLICT DO NOTHING", (f"slack-reply:{event.event_id}", Jsonb(data)))

    @asynccontextmanager
    async def delivery_lock(self):
        async with self.repository.connection() as conn:
            row = await (await conn.execute("SELECT pg_try_advisory_xact_lock(813780) AS held")).fetchone()
            yield bool(row["held"])

    async def pending(self):
        async with self.repository.connection() as conn:
            return await (await conn.execute("SELECT id,work_id,data FROM notifications WHERE NOT delivered AND NOT failed AND next_attempt_at <= clock_timestamp() ORDER BY id LIMIT 100")).fetchall()

    async def mark_delivered(self, ids):
        async with self.repository.connection() as conn:
            await conn.execute("UPDATE notifications SET delivered=true WHERE id=ANY(%s)", (ids,))

    async def mark_uncertain(self, ids):
        async with self.repository.connection() as conn:
            await conn.execute("UPDATE notifications SET failed=true,last_error='SLACK_DELIVERY_UNCERTAIN',attempts=attempts+1,data=data || '{\"delivery_state\":\"uncertain\"}'::jsonb WHERE id=ANY(%s)", (ids,))

    async def mark_failed(self, ids, code):
        async with self.repository.connection() as conn:
            await conn.execute("""UPDATE notifications SET attempts=attempts+1, last_error=%s,
                failed=attempts+1>=6, next_attempt_at=clock_timestamp()+
                make_interval(secs=>LEAST(3600,60*power(2,LEAST(attempts,6)))::int)
                WHERE id=ANY(%s) AND NOT delivered""", (code, ids))

    async def effect(self, key):
        async with self.repository.connection() as conn:
            return await (await conn.execute("SELECT * FROM effects WHERE operation_key=%s", (key,))).fetchone()

    async def thread(self, work_id):
        async with self.repository.connection() as conn:
            return await (await conn.execute("SELECT channel,thread_ts FROM sabre_slack_threads WHERE work_id=%s", (work_id,))).fetchone()

    async def save_thread(self, work_id, channel, thread_ts):
        async with self.repository.connection() as conn:
            await conn.execute("INSERT INTO sabre_slack_threads VALUES(%s,%s,%s) ON CONFLICT DO NOTHING", (work_id, channel, thread_ts))


async def owner_dm(client, owner_id: str) -> str:
    response = await client.conversations_open(users=owner_id)
    channel = response.get("channel", {}).get("id", "")
    if not re.fullmatch(r"D[A-Z0-9]+", channel):
        raise DomainError("SLACK_IDENTITY", "Could not verify the owner direct message")
    return channel


async def admit_message(service, event: dict) -> dict:
    service.guard.check(event)
    try:
        message = SlackMessage.model_validate(event)
    except ValidationError:
        raise DomainError("INVALID_SLACK_MESSAGE", "The message has an unsupported format", 422) from None
    if not service.config.slack_owner_id or message.user != service.config.slack_owner_id:
        raise DomainError("SLACK_OWNER_REQUIRED", "Only the owner can direct the factory", 403)
    client = getattr(service, "slack_client", None) or AsyncWebClient(token=service.config.slack_bot_token.get_secret_value(), timeout=15)
    channel = await owner_dm(client, message.user)
    if message.channel != channel:
        raise DomainError("SLACK_DM_REQUIRED", "Use the direct message with SABRE", 403)
    store = service.queue.slack_store
    return await store.admit(message, service.queue.slack_message)


async def register_jobs(runtime):
    store = SlackStore(runtime.repository)
    await store.initialize()
    runtime.slack_store = store
    conversation = SlackConversation(runtime.service, store, runtime.checkpointer)

    @runtime.queue.task(name="sabre.slack_message", queue="slack", retry=3)
    async def process_message(event_id: str):
        inbox = await store.inbox(event_id)
        if not inbox or inbox["state"] == "completed":
            return
        event = SlackMessage.model_validate(inbox["data"])
        try:
            reply = await guarded_call(conversation.reply, runtime.service.guard, "SLACK_CONVERSATION_FAILED", event)
        except DomainError as error:
            runtime.service.guard.check(error.message)
            reply = f"Cannot continue: {error.message}. Code: {error.code}."
        await store.complete(event, reply)
        await guarded_call(deliver_notifications, runtime.service.guard, "SLACK_DELIVERY_FAILED", runtime.repository, runtime.config, runtime.service.guard, store=store, credentials=getattr(runtime, "credentials", None))

    runtime.slack_message = process_message


def slack_text(text: str) -> str:
    return text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


async def reconcile_message(client, channel: str, key: str, thread_ts: str | None):
    cursor = None
    for _ in range(5):
        kwargs = {"channel": channel, "limit": 100, "include_all_metadata": True}
        if cursor:
            kwargs["cursor"] = cursor
        if thread_ts:
            response = await client.conversations_replies(ts=thread_ts, **kwargs)
        else:
            response = await client.conversations_history(**kwargs)
        for item in response.get("messages", []):
            if item.get("metadata", {}).get("event_payload", {}).get("delivery_key") == key:
                return {"channel": channel, "ts": item["ts"]}
        cursor = response.get("response_metadata", {}).get("next_cursor")
        if not cursor:
            return None
    return None


async def post_once(repository, store, client, guard, key: str, channel: str, text: str, thread_ts: str | None = None):
    request = {"channel": channel, "text": text, "thread_ts": thread_ts}
    guard.check(request)
    previous = await store.effect(key)
    if previous:
        if previous["state"] == "completed":
            return previous["result"]
        receipt = await reconcile_message(client, channel, key, thread_ts)
        if receipt:
            await repository.finish_effect(key, receipt)
            return receipt
        raise DomainError("SLACK_DELIVERY_UNCERTAIN", "Cannot confirm an earlier notification; it will not be repeated blindly")
    await repository.begin_effect(key, request)
    response = await client.chat_postMessage(channel=channel, text=slack_text(text), thread_ts=thread_ts, unfurl_links=False, unfurl_media=False, mrkdwn=False, metadata={"event_type": "sabre_notice", "event_payload": {"delivery_key": key}}, client_msg_id=str(uuid5(NAMESPACE_URL, key)))
    receipt = {"channel": channel, "ts": response["ts"]}
    await repository.finish_effect(key, receipt)
    return receipt


async def work_thread(repository, store, client, guard, work, channel):
    existing = await store.thread(work.id)
    if existing:
        if existing["channel"] != channel:
            raise DomainError("SLACK_IDENTITY", "The thread does not belong to the direct message with the owner")
        return existing["thread_ts"]
    if work.channel == "slack" and work.channel_thread:
        old_channel, _, ts = work.channel_thread.partition("/")
        if old_channel == channel and re.fullmatch(r"\d+\.\d+", ts):
            await store.save_thread(work.id, channel, ts)
            return ts
    receipt = await post_once(repository, store, client, guard, f"slack-work:{work.id}", channel, f"SABRE work order\n{work.objective}\nIdentifier: {work.id}")
    await store.save_thread(work.id, channel, receipt["ts"])
    return receipt["ts"]


async def deliver_notifications(repository, cfg, guard, *, store=None, client=None, credentials=None):
    if credentials:
        await credentials.refresh()
    if not cfg.slack_bot_token.get_secret_value() or not cfg.slack_owner_id:
        return
    store = store or SlackStore(repository)
    client = client or AsyncWebClient(token=cfg.slack_bot_token.get_secret_value(), timeout=15)
    if credentials:
        client = CredentialSlackClient(client, credentials)
    async with store.delivery_lock() as held:
        if not held:
            return
        pending = await store.pending()
        if not pending:
            return
        try:
            channel = await owner_dm(client, cfg.slack_owner_id)
        except (DomainError, httpx.TransportError, SlackApiError) as error:
            if not hasattr(store, "mark_failed"):
                raise
            await store.mark_failed([item["id"] for item in pending], getattr(error, "code", "SLACK_CHANNEL_UNAVAILABLE"))
            return
        groups: dict[str, list[dict[str, Any]]] = {}
        for notice in pending:
            group = notice["work_id"] or notice["id"]
            groups.setdefault(group, []).append(notice)
        for notices in groups.values():
            ids = [item["id"] for item in notices]
            try:
                if notices[0]["work_id"]:
                    work = await repository.work(notices[0]["work_id"])
                    thread_ts = await work_thread(repository, store, client, guard, work, channel)
                    pending_questions = open_questions(work)
                    state = {"work": work.id, "revision": work.plan_revision, "status": work.status, "phase": work.phase, "summary": work.summary, "questions": [payload(item) for item in pending_questions], "findings": [item.fingerprint for item in work.findings]}
                    text = f"{work.summary}\nStatus: {STATE_LABELS.get(work.status, 'in progress')} · Phase: {PHASE_LABELS.get(work.phase, 'in progress')}"
                    for question in pending_questions:
                        text += f"\n\nYour response is needed: {question.prompt}\nDecision {question.id} · revision {question.plan_revision}"
                    if work.evidence and work.evidence.pr_url:
                        text += f"\nPR: {work.evidence.pr_url}"
                    key = f"slack-notice:{digest(state)}"
                else:
                    data = notices[0]["data"]
                    if data.get("channel") != channel:
                        raise DomainError("SLACK_IDENTITY", "The notification does not belong to the owner")
                    thread_ts, text, key = data["thread_ts"], data["message"], notices[0]["id"]
                await post_once(repository, store, client, guard, key, channel, text[:3800], thread_ts)
                await store.mark_delivered(ids)
            except DomainError as error:
                if error.code == "SLACK_DELIVERY_UNCERTAIN":
                    await store.mark_uncertain(ids)
                elif hasattr(store, "mark_failed"):
                    await store.mark_failed(ids, error.code)
                else:
                    raise
            except (httpx.TransportError, SlackApiError):
                if hasattr(store, "mark_failed"):
                    await store.mark_failed(ids, "SLACK_TRANSPORT_ERROR")
                else:
                    raise


class GatewaySettings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="SABRE_", extra="ignore", hide_input_in_errors=True)
    gateway_token: SecretStr
    bootstrap_file: str | None = None
    api_url: str = "http://api:8000"
    slack_bot_token: SecretStr = SecretStr("")
    slack_app_token: SecretStr = SecretStr("")
    slack_owner_id: str

    @model_validator(mode="before")
    @classmethod
    def bootstrap(cls, values):
        reject_secret_environment()
        path = values.get("bootstrap_file") or os.environ.get("SABRE_BOOTSTRAP_FILE")
        return load_bootstrap(path, kind="gateway") | values if path else values


def build_gateway(cfg, api_client, guard):
    app = AsyncApp(token=cfg.slack_bot_token.get_secret_value(), process_before_response=True)

    @app.event("message")
    async def message_listener(body, event, ack):
        if event.get("user") != cfg.slack_owner_id or event.get("subtype") or event.get("bot_id") or event.get("channel_type") != "im":
            await ack()
            return
        request = {"event_id": body.get("event_id"), "user": event.get("user"), "channel": event.get("channel"), "channel_type": event.get("channel_type"), "ts": event.get("ts"), "thread_ts": event.get("thread_ts"), "text": event.get("text", "")}
        guard.check(request)
        response = await api_client.post("/api/v1/chat", json=request)
        response.raise_for_status()
        await ack()

    return app


async def main():
    cfg = GatewaySettings()
    guard = SecretGuard([cfg.gateway_token.get_secret_value()])
    async with httpx.AsyncClient(base_url=cfg.api_url, headers={"Authorization": f"Bearer {cfg.gateway_token.get_secret_value()}"}, timeout=10, follow_redirects=False) as api:
        await run_gateway(cfg, api, guard)


class CredentialSlackClient:
    """Refresh the bot credential before every authenticated Slack operation."""

    def __init__(self, client, credentials):
        self.client, self.credentials = client, credentials

    def __getattr__(self, name):
        async def call(**kwargs):
            token = (await self.credentials.resolve("slack.bot")).get_secret_value()
            if not token:
                raise DomainError("SLACK_NOT_CONFIGURED", "The Slack bot credential is missing")
            self.client.token = token
            return await getattr(self.client, name)(**kwargs)
        return call


async def run_gateway(cfg, api, guard, *, interval=10, handler_factory=AsyncSocketModeHandler):
    handler, previous = None, None
    try:
        while True:
            current = await fetch_credentials(cfg.api_url, cfg.gateway_token.get_secret_value(), "slack", client=api)
            if current != previous:
                if handler:
                    await handler.close_async()
                    handler = None
                guard.known_secrets = tuple(dict.fromkeys((*guard.known_secrets, *(value for value in current.values() if value))))
                cfg.slack_bot_token, cfg.slack_app_token = SecretStr(current["bot_token"]), SecretStr(current["app_token"])
                if current["bot_token"] and current["app_token"]:
                    handler = handler_factory(build_gateway(cfg, api, guard), current["app_token"])
                    await handler.connect_async()
                previous = current
            await asyncio.sleep(interval)
    finally:
        if handler:
            await handler.close_async()


if __name__ == "__main__":
    asyncio.run(main())
