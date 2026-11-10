"""Signed, at-least-once webhook delivery with durable bounded retries."""

import hashlib
import hmac
import json
import time
from datetime import timedelta
from typing import Literal

import httpx2
from psycopg.types.json import Jsonb
from pydantic import Field, field_validator

from sabre.contracts import StrictContract
from sabre.models import DomainError, new_id, now


class WebhookDestination(StrictContract):
    endpoint: str

    @field_validator("endpoint")
    @classmethod
    def public_https(cls, value):
        from sabre.mcp_connections import normalized_endpoint
        return normalized_endpoint(value)


class Notification(StrictContract):
    version: Literal[1] = 1
    id: str
    type: Literal["work.updated"] = "work.updated"
    work_id: str
    project_id: str
    plan_revision: int = Field(ge=1)
    status: str
    phase: str


class DeliveryStatus(StrictContract):
    id: str
    event_id: str
    destination: str
    attempts: int
    state: Literal["pending", "sending", "delivered", "failed", "uncertain"]
    last_error: str | None


def destination_id(name, endpoint):
    return f"{name}:{hashlib.sha256(endpoint.encode()).hexdigest()[:16]}"


def signed_headers(event_id: str, body: bytes, secret: str, timestamp: int) -> dict[str, str]:
    material = str(timestamp).encode() + b"." + event_id.encode() + b"." + body
    signature = hmac.new(secret.encode(), material, hashlib.sha256).hexdigest()
    return {"Content-Type": "application/json", "X-Sabre-Event-Id": event_id,
            "X-Sabre-Timestamp": str(timestamp), "X-Sabre-Signature": f"v1={signature}"}


async def enqueue_notifications(conn, destinations, event_id, work):
    notice = Notification(id=event_id, work_id=work.id, project_id=work.project_id,
        plan_revision=work.plan_revision, status=work.status.value, phase=work.phase)
    for name, destination in destinations.items():
        await conn.execute("""INSERT INTO notification_outbox(id,event_id,destination,payload)
            VALUES(%s,%s,%s,%s) ON CONFLICT(event_id,destination) DO NOTHING""",
            (new_id(), event_id, destination_id(name, destination.endpoint), Jsonb(notice.model_dump(mode="json"))))


class WebhookDelivery:
    def __init__(self, repository, destinations, credentials):
        self.repository, self.destinations, self.credentials = repository, destinations, credentials

    async def claim(self):
        async with self.repository.connection() as conn:
            await conn.execute("""UPDATE notification_outbox SET state='failed',last_error='DELIVERY_UNCERTAIN',lease_until=NULL
                WHERE state='sending' AND lease_until<clock_timestamp() AND attempts>=6""")
            return await (await conn.execute("""UPDATE notification_outbox SET state='sending', attempts=attempts+1,
                lease_until=clock_timestamp()+interval '90 seconds' WHERE id IN (
                SELECT id FROM notification_outbox WHERE
                (state='pending' AND next_attempt_at<=clock_timestamp()) OR
                (state='sending' AND lease_until<clock_timestamp())
                ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING *""")).fetchall()

    async def settle(self, item, *, error=None, retry=False, delay=None):
        state = "delivered" if error is None else "pending" if retry and item["attempts"] < 6 else "failed"
        seconds = min(3600, max(1, delay if delay is not None else 60 * 2 ** min(item["attempts"] - 1, 6)))
        async with self.repository.connection() as conn:
            await conn.execute("""UPDATE notification_outbox SET state=%s,last_error=%s,lease_until=NULL,next_attempt_at=%s
                WHERE id=%s AND state='sending' AND attempts=%s""",
                (state, error, now() + timedelta(seconds=seconds), item["id"], item["attempts"]))

    async def deliver(self):
        from sabre.mcp_connections import PublicMCPTransport
        for item in await self.claim():
            name = item["destination"].split(":", 1)[0]
            destination = self.destinations.get(name)
            if destination is None or destination_id(name, destination.endpoint) != item["destination"]:
                await self.settle(item, error="DESTINATION_CHANGED")
                continue
            try:
                revision = await self.credentials.refresh()
                secret = (await self.credentials.resolve(f"webhook.{name}" )).get_secret_value()
                if len(secret) < 32:
                    await self.settle(item, error="SIGNING_KEY_UNAVAILABLE")
                    continue
                body = json.dumps(item["payload"], sort_keys=True, separators=(",", ":")).encode()
                headers = signed_headers(item["event_id"], body, secret, int(time.time()))
                async def authorize(expected_revision=revision):
                    await self.credentials.assert_current(expected_revision, include_models=False)
                transport = PublicMCPTransport(destination.endpoint, credential_check=authorize,
                    allowed_statuses={"POST": {*range(200, 300), 408, 429, *range(500, 600)}})
                async with httpx2.AsyncClient(transport=transport, timeout=15, follow_redirects=False, trust_env=False) as client:
                    response = await client.post(destination.endpoint, content=body, headers=headers)
                if 200 <= response.status_code < 300:
                    await self.settle(item)
                else:
                    delay = response.headers.get("retry-after", "")
                    await self.settle(item, error=f"HTTP_{response.status_code}", retry=True,
                        delay=int(delay) if delay.isdigit() else None)
            except httpx2.TransportError:
                await self.settle(item, error="TRANSPORT_ERROR", retry=True)
            except DomainError as error:
                await self.settle(item, error=error.code)

    async def statuses(self):
        async with self.repository.connection() as conn:
            rows = await (await conn.execute("""SELECT id,event_id,destination,attempts,state,last_error
                FROM notification_outbox UNION ALL
                SELECT 'slack:'||id AS id,id AS event_id,'slack' AS destination,attempts,
                CASE WHEN delivered THEN 'delivered' WHEN last_error='SLACK_DELIVERY_UNCERTAIN' THEN 'uncertain'
                WHEN failed THEN 'failed' ELSE 'pending' END AS state,last_error
                FROM notifications ORDER BY id DESC LIMIT 100""")).fetchall()
        return [DeliveryStatus(**row) for row in rows]

    async def retry(self, identifier):
        async with self.repository.connection() as conn:
            if identifier.startswith("slack:"):
                row = await (await conn.execute("""UPDATE notifications SET failed=false,attempts=0,last_error=NULL,
                    next_attempt_at=clock_timestamp() WHERE id=%s AND failed AND last_error != 'SLACK_DELIVERY_UNCERTAIN'
                    RETURNING id""", (identifier[6:],))).fetchone()
            else:
                row = await (await conn.execute("""UPDATE notification_outbox SET state='pending',attempts=0,
                next_attempt_at=clock_timestamp(),last_error=NULL WHERE id=%s AND state='failed' RETURNING id""", (identifier,))).fetchone()
            if not row:
                raise DomainError("DELIVERY_NOT_FAILED", "Only a failed delivery can be queued again", 409)
        return await self.statuses()
