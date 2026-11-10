import asyncio
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace

import httpx
import pytest
from pydantic import SecretStr

from sabre.api import create_app

ORIGIN = "http://127.0.0.1:8000"
OWNER = "synthetic-owner-panel-token-long-enough"
BEARER = {"Authorization": "Bearer " + OWNER}
UI = {"X-Sabre-UI": "1", "Sec-Fetch-Site": "same-origin"}
WRITE = UI | {"Origin": ORIGIN}


class SessionRepository:
    def __init__(self):
        self.tickets = {}
        self.sessions = {}
        self.clock = datetime.now(UTC)
        self.lock = asyncio.Lock()

    async def issue_panel_ticket(self, ticket_hash, origin, epoch):
        self.tickets[ticket_hash] = (origin, epoch, self.clock + timedelta(seconds=60))

    async def exchange_panel_ticket(self, ticket_hash, session_hash, origin, epoch):
        async with self.lock:
            row = self.tickets.get(ticket_hash)
            if not row or row[:2] != (origin, epoch) or row[2] <= self.clock:
                return None
            del self.tickets[ticket_hash]
            expiry = self.clock + timedelta(hours=8)
            self.sessions[session_hash] = (origin, epoch, expiry)
            return expiry

    async def panel_session(self, session_hash, origin, epoch):
        row = self.sessions.get(session_hash)
        return row[2] if row and row[:2] == (origin, epoch) and row[2] > self.clock else None

    async def revoke_panel_session(self, session_hash):
        self.sessions.pop(session_hash, None)


class Service:
    def __init__(self):
        self.repository = SessionRepository()
        self.writes = 0

    async def status(self):
        return {"database": "connected"}

    async def control(self, work_id, action):
        self.writes += 1
        return {}


def application(service=None):
    service = service or Service()
    cfg = SimpleNamespace(auth_token=SecretStr(OWNER), executor_token=SecretStr("synthetic-broker-token"),
                          gateway_token=SecretStr("synthetic-gateway-token"), allowed_origins=[ORIGIN], panel_origin=ORIGIN)
    return create_app(service, cfg)


async def exchange(client):
    issued = await client.post("/api/v1/panel/session-ticket", headers=BEARER)
    assert issued.status_code == 201
    ticket = issued.json()["ticket"]
    result = await client.post("/api/v1/panel/session/exchange", headers=WRITE, json={"ticket": ticket})
    assert result.status_code == 200
    return ticket, result


async def test_owner_ticket_opens_panel_without_revealing_owner_token_and_logs_out():
    service = Service()
    async with httpx.AsyncClient(transport=httpx.ASGITransport(application(service)), base_url=ORIGIN) as client:
        ticket, result = await exchange(client)
        cookie = result.headers["set-cookie"].lower()
        assert "httponly" in cookie and "samesite=strict" in cookie and "path=/api/v1" in cookie
        assert "domain=" not in cookie
        assert result.headers["cache-control"] == "no-store"
        assert OWNER not in result.text and ticket not in result.text
        csrf = result.json()["csrf_token"]
        restored = await client.get("/api/v1/panel/session", headers=UI)
        assert restored.json()["csrf_token"] == csrf
        assert (await client.get("/api/v1/status", headers=UI)).status_code == 200
        assert (await client.post("/api/v1/panel/session/logout", headers=WRITE | {"X-CSRF-Token": csrf})).status_code == 204
        assert (await client.get("/api/v1/status", headers=UI)).status_code == 401
        assert not service.repository.sessions


async def test_ticket_replay_and_expiry_fail_without_creating_another_session():
    service = Service()
    async with httpx.AsyncClient(transport=httpx.ASGITransport(application(service)), base_url=ORIGIN) as client:
        ticket, _ = await exchange(client)
        assert (await client.post("/api/v1/panel/session/exchange", headers=WRITE, json={"ticket": ticket})).status_code == 401
        second = (await client.post("/api/v1/panel/session-ticket", headers=BEARER)).json()["ticket"]
        service.repository.clock += timedelta(seconds=60)
        assert (await client.post("/api/v1/panel/session/exchange", headers=WRITE, json={"ticket": second})).status_code == 401
        assert len(service.repository.sessions) == 1
        service.repository.clock += timedelta(hours=8)
        assert (await client.get("/api/v1/status", headers=UI)).status_code == 401


@pytest.mark.parametrize("changes", [
    {"Origin": "https://attacker.example"}, {"Origin": "null"}, {"Origin": None},
    {"Origin": "http://127.0.0.1:8001"}, {"Host": "attacker.example:8000"},
    {"Host": "127.0.0.1:8001"}, {"Sec-Fetch-Site": "cross-site"},
    {"Sec-Fetch-Site": "same-site"}, {"Sec-Fetch-Site": None}, {"X-Sabre-UI": None},
    {"Forwarded": "host=127.0.0.1:8000"}, {"X-Forwarded-Host": "127.0.0.1:8000"},
])
async def test_exchange_rejects_untrusted_browser_context_without_consuming_ticket(changes):
    service = Service()
    headers = {key: value for key, value in (WRITE | changes).items() if value is not None}
    async with httpx.AsyncClient(transport=httpx.ASGITransport(application(service)), base_url=ORIGIN) as client:
        ticket = (await client.post("/api/v1/panel/session-ticket", headers=BEARER)).json()["ticket"]
        response = await client.post("/api/v1/panel/session/exchange", headers=headers, json={"ticket": ticket})
        assert response.status_code == 403
        assert ticket not in response.text
        assert len(service.repository.tickets) == 1
        assert not service.repository.sessions


async def test_cookie_cannot_mint_tickets_authorize_mcp_private_adapters_or_invalid_bearer():
    async with httpx.AsyncClient(transport=httpx.ASGITransport(application()), base_url=ORIGIN) as client:
        _, result = await exchange(client)
        headers = WRITE | {"X-CSRF-Token": result.json()["csrf_token"]}
        cookie_headers = UI | {"Cookie": "; ".join(f"{key}={value}" for key, value in client.cookies.items())}
        for path in ["/mcp/", "/internal/credentials/github-read", "/internal/credentials/slack"]:
            assert (await client.get(path, headers=cookie_headers)).status_code == 401
        assert (await client.post("/api/v1/panel/session-ticket", headers=headers)).status_code == 401
        assert (await client.get("/api/v1/status", headers=UI | {"Authorization": "Bearer wrong"})).status_code == 401
        assert (await client.get("/api/v1/status")).status_code == 403


@pytest.mark.parametrize("changes", [{"X-CSRF-Token": None}, {"X-CSRF-Token": "wrong"}, {"Origin": None},
                                       {"Origin": "null"}, {"Sec-Fetch-Site": "same-site"}])
async def test_cookie_mutations_require_csrf_and_exact_origin(changes):
    async with httpx.AsyncClient(transport=httpx.ASGITransport(application()), base_url=ORIGIN) as client:
        _, result = await exchange(client)
        headers = {key: value for key, value in (WRITE | {"X-CSRF-Token": result.json()["csrf_token"]} | changes).items() if value is not None}
        response = await client.post("/api/v1/panel/session/logout", headers=headers)
        assert response.status_code == 403
        assert (await client.get("/api/v1/status", headers=UI)).status_code == 200


async def test_ticket_is_atomic_and_session_survives_new_application_instance():
    service = Service()
    async with httpx.AsyncClient(transport=httpx.ASGITransport(application(service)), base_url=ORIGIN) as client:
        ticket = (await client.post("/api/v1/panel/session-ticket", headers=BEARER)).json()["ticket"]
        attempts = await asyncio.gather(*[client.post("/api/v1/panel/session/exchange", headers=WRITE, json={"ticket": ticket}) for _ in range(2)])
        assert sorted(response.status_code for response in attempts) == [200, 401]
        assert len(service.repository.sessions) == 1
        cookies = client.cookies
    async with httpx.AsyncClient(transport=httpx.ASGITransport(application(service)), base_url=ORIGIN, cookies=cookies) as restarted:
        assert (await restarted.get("/api/v1/panel/session", headers=UI)).status_code == 200


async def test_session_is_bound_to_current_owner_identity():
    app = application()
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url=ORIGIN) as client:
        await exchange(client)
        app.state.config.auth_token = SecretStr("synthetic-rotated-owner-token-long-enough")
        assert (await client.get("/api/v1/status", headers=UI)).status_code == 401
