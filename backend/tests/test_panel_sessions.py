import asyncio
import uuid
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace

import httpx
import pytest
from pydantic import SecretStr

from sabre.api import create_app
from sabre.panel_sessions import client_label

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
        self.renewals = 0

    async def issue_panel_ticket(self, ticket_hash, origin, epoch):
        self.tickets[ticket_hash] = (origin, epoch, self.clock + timedelta(seconds=60))

    async def exchange_panel_ticket(self, ticket_hash, session_hash, origin, epoch, *, lifetime_seconds=8 * 3600, client=""):
        async with self.lock:
            row = self.tickets.get(ticket_hash)
            if not row or row[:2] != (origin, epoch) or row[2] <= self.clock:
                return None
            del self.tickets[ticket_hash]
            expiry = self.clock + timedelta(seconds=lifetime_seconds)
            self.sessions[session_hash] = {"origin": origin, "epoch": epoch, "expires_at": expiry, "client": client,
                                           "id": str(uuid.uuid4()), "created_at": self.clock, "last_used_at": self.clock}
            return expiry

    async def panel_session(self, session_hash, origin, epoch, *, renew_seconds=None):
        row = self.sessions.get(session_hash)
        if not row or (row["origin"], row["epoch"]) != (origin, epoch) or row["expires_at"] <= self.clock:
            return None
        if renew_seconds is not None and row["last_used_at"] < self.clock - timedelta(hours=1):
            row["last_used_at"] = self.clock
            row["expires_at"] = max(row["expires_at"], self.clock + timedelta(seconds=renew_seconds))
            self.renewals += 1
        return row["expires_at"]

    async def revoke_panel_session(self, session_hash):
        self.sessions.pop(session_hash, None)

    async def list_panel_sessions(self, origin, epoch):
        rows = [{"session_hash": key, **row} for key, row in self.sessions.items()
                if (row["origin"], row["epoch"]) == (origin, epoch) and row["expires_at"] > self.clock]
        return sorted(rows, key=lambda row: row["last_used_at"], reverse=True)

    async def revoke_panel_session_by_id(self, session_id, origin, epoch):
        for key, row in list(self.sessions.items()):
            if row["id"] == session_id and (row["origin"], row["epoch"]) == (origin, epoch):
                del self.sessions[key]
                return True
        return False


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
        service.repository.clock += timedelta(days=30)
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


async def test_session_slides_with_use_and_expires_after_thirty_idle_days():
    service = Service()
    async with httpx.AsyncClient(transport=httpx.ASGITransport(application(service)), base_url=ORIGIN) as client:
        _, result = await exchange(client)
        cookie = result.headers["set-cookie"].lower()
        assert f"max-age={400 * 86400}" in cookie
        first = datetime.fromisoformat(result.json()["expires_at"])
        assert first == service.repository.clock + timedelta(days=30)
        for _ in range(3):
            service.repository.clock += timedelta(days=20)
            assert (await client.get("/api/v1/status", headers=UI)).status_code == 200
        assert service.repository.renewals == 3
        renewed = datetime.fromisoformat((await client.get("/api/v1/panel/session", headers=UI)).json()["expires_at"])
        assert renewed == service.repository.clock + timedelta(days=30)
        # Frequent polling within the hour does not rewrite the session.
        for _ in range(5):
            assert (await client.get("/api/v1/status", headers=UI)).status_code == 200
        assert service.repository.renewals == 3
        service.repository.clock += timedelta(days=30)
        assert (await client.get("/api/v1/status", headers=UI)).status_code == 401


async def test_configured_session_lifetime_is_respected():
    service = Service()
    app = application(service)
    app.state.config.panel_session_days = 1
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url=ORIGIN) as client:
        _, result = await exchange(client)
        assert datetime.fromisoformat(result.json()["expires_at"]) == service.repository.clock + timedelta(days=1)


async def test_paired_browsers_are_listed_without_capabilities_and_can_be_revoked():
    service = Service()
    app = application(service)
    agent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36"
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url=ORIGIN) as other, \
            httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url=ORIGIN, headers={"User-Agent": agent}) as client:
        await exchange(other)
        _, result = await exchange(client)
        csrf = result.json()["csrf_token"]
        listed = await client.get("/api/v1/panel/browsers", headers=UI)
        assert listed.status_code == 200
        body = listed.json()
        assert body["lifetime_days"] == 30
        assert sorted(item["current"] for item in body["browsers"]) == [False, True]
        current = next(item for item in body["browsers"] if item["current"])
        assert current["client"] == "Chrome on Windows"
        assert set(current) == {"id", "client", "current", "created_at", "last_used_at", "expires_at"}
        for session_hash in service.repository.sessions:
            assert session_hash not in listed.text
        for value in client.cookies.values():
            assert value not in listed.text
        remote = next(item for item in body["browsers"] if not item["current"])
        mutation = WRITE | {"X-CSRF-Token": csrf}
        assert (await client.delete(f"/api/v1/panel/browsers/{remote['id']}", headers=UI | {"Origin": ORIGIN})).status_code == 403
        assert (await client.delete(f"/api/v1/panel/browsers/{remote['id']}", headers=mutation)).status_code == 204
        assert (await other.get("/api/v1/status", headers=UI)).status_code == 401
        assert (await client.delete(f"/api/v1/panel/browsers/{remote['id']}", headers=mutation)).status_code == 404
        assert (await client.delete("/api/v1/panel/browsers/not-an-id", headers=mutation)).status_code == 404
        assert (await client.get("/api/v1/status", headers=UI)).status_code == 200


async def test_paired_browsers_require_a_panel_session():
    async with httpx.AsyncClient(transport=httpx.ASGITransport(application()), base_url=ORIGIN) as client:
        assert (await client.get("/api/v1/panel/browsers", headers=BEARER)).status_code == 401


@pytest.mark.parametrize(("agent", "label"), [
    ("Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15", "Safari on macOS"),
    ("Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0", "Firefox on Linux"),
    ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0 Safari/537.36 Edg/140.0", "Edge on Windows"),
    ("", "Browser"),
])
def test_client_label_is_coarse(agent, label):
    assert client_label(agent) == label
