"""Paired browser access: a one-use launcher grant becomes a sliding, revocable browser session."""

import hashlib
import hmac
import re
import secrets
from datetime import datetime, timedelta
from urllib.parse import urlsplit

from pydantic import BaseModel, ConfigDict, Field, SecretStr

from sabre.models import DomainError

COOKIE = "sabre_panel_session"
COOKIE_PATH = "/api/v1"
# Browsers cap cookie lifetime at 400 days; the sliding server-side expiry decides validity.
COOKIE_MAX_AGE = 400 * 86400
DEFAULT_ORIGIN = "http://127.0.0.1:8000"
CAPABILITY = re.compile(r"[A-Za-z0-9_-]{43}\Z")
SESSION_ID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\Z")
DEFAULT_LIFETIME = timedelta(days=30)


class TicketExchange(BaseModel):
    model_config = ConfigDict(extra="forbid", hide_input_in_errors=True)
    ticket: SecretStr = Field(min_length=43, max_length=43)


def canonical_origin(value: str) -> str:
    try:
        parsed = urlsplit(value)
        valid = (parsed.scheme in {"http", "https"} and parsed.hostname in {"localhost", "127.0.0.1", "::1"}
                 and parsed.port is not None and parsed.port > 0 and not parsed.username and not parsed.password
                 and not parsed.path and not parsed.query and not parsed.fragment
                 and parsed.netloc == (f"[{parsed.hostname}]" if parsed.hostname == "::1" else parsed.hostname) + f":{parsed.port}")
    except (TypeError, ValueError):
        valid = False
    if not valid:
        raise DomainError("PANEL_ORIGIN_INVALID", "The panel origin must be a local address with an explicit port", 503)
    return value


def browser_context(request, origin: str, *, mutation: bool) -> None:
    target = urlsplit(origin)
    hosts = request.headers.getlist("host")
    source = request.headers.get("origin")
    forwarded = any(key == "forwarded" or key.startswith("x-forwarded-") for key in request.headers)
    if (hosts != [target.netloc] or request.url.scheme != target.scheme or forwarded
            or request.headers.get("sec-fetch-site") != "same-origin"
            or request.headers.get("x-sabre-ui") != "1"
            or (source is not None and source != origin) or (mutation and source != origin)):
        raise DomainError("PANEL_ORIGIN_DENIED", "Open the panel from its authorized local address", 403)


def client_label(user_agent: str) -> str:
    """Coarse browser and platform label shown in Config > Access; the full user agent is never stored."""
    agent = user_agent or ""
    browser = next((name for token, name in (("Edg/", "Edge"), ("OPR/", "Opera"), ("Firefox/", "Firefox"),
                                             ("Chrome/", "Chrome"), ("Safari/", "Safari")) if token in agent), "Browser")
    system = next((name for token, name in (("Windows", "Windows"), ("Android", "Android"), ("iPhone", "iOS"),
                                            ("iPad", "iPadOS"), ("Mac OS X", "macOS"), ("Linux", "Linux")) if token in agent), "")
    return f"{browser} on {system}" if system else browser


class PanelSessions:
    def __init__(self, repository, owner_token: str, origin: str, lifetime: timedelta = DEFAULT_LIFETIME):
        self.repository = repository
        self.origin = canonical_origin(origin)
        self.lifetime = int(lifetime.total_seconds())
        self.key = owner_token.encode()
        self.epoch = hmac.digest(self.key, b"sabre.panel.owner.v1", "sha256").hex()

    @staticmethod
    def hashed(value: str) -> str:
        return hashlib.sha256(value.encode()).hexdigest()

    def csrf(self, session: str) -> str:
        return hmac.digest(self.key, b"sabre.panel.csrf.v1\0" + session.encode(), "sha256").hex()

    async def issue(self):
        ticket = secrets.token_urlsafe(32)
        await self.repository.issue_panel_ticket(self.hashed(ticket), self.origin, self.epoch)
        return {"ticket": ticket, "expires_in": 60, "origin": self.origin}

    async def exchange(self, ticket: str, user_agent: str = ""):
        if not CAPABILITY.fullmatch(ticket):
            raise DomainError("SESSION_TICKET_INVALID", "The access link expired or has already been used", 401)
        session = secrets.token_urlsafe(32)
        expires = await self.repository.exchange_panel_ticket(self.hashed(ticket), self.hashed(session), self.origin, self.epoch,
                                                              lifetime_seconds=self.lifetime, client=client_label(user_agent))
        if expires is None:
            raise DomainError("SESSION_TICKET_INVALID", "The access link expired or has already been used", 401)
        return session, self.payload(session, expires)

    async def authenticate(self, request):
        session = request.cookies.get(COOKIE, "")
        if not CAPABILITY.fullmatch(session):
            raise DomainError("PANEL_SESSION_REQUIRED", "Open SABRE from its local launcher", 401)
        browser_context(request, self.origin, mutation=request.method not in {"GET", "HEAD"})
        expires = await self.repository.panel_session(self.hashed(session), self.origin, self.epoch, renew_seconds=self.lifetime)
        if expires is None:
            raise DomainError("PANEL_SESSION_REQUIRED", "The panel session expired; open SABRE again", 401)
        if request.method not in {"GET", "HEAD"} and not hmac.compare_digest(request.headers.get("x-csrf-token", "").encode(), self.csrf(session).encode()):
            raise DomainError("PANEL_CSRF_DENIED", "The request does not belong to this panel session", 403)
        return self.payload(session, expires)

    def payload(self, session: str, expires: datetime):
        return {"authenticated": True, "csrf_token": self.csrf(session), "expires_at": expires.isoformat()}

    async def revoke(self, request):
        await self.repository.revoke_panel_session(self.hashed(request.cookies[COOKIE]))

    async def paired(self, request) -> list[dict]:
        current = self.hashed(request.cookies.get(COOKIE, ""))
        rows = await self.repository.list_panel_sessions(self.origin, self.epoch)
        return [{"id": row["id"], "client": row["client"] or "Browser", "current": hmac.compare_digest(row["session_hash"], current),
                 "created_at": row["created_at"].isoformat(), "last_used_at": row["last_used_at"].isoformat(),
                 "expires_at": row["expires_at"].isoformat()} for row in rows]

    async def revoke_paired(self, session_id: str) -> None:
        if not SESSION_ID.fullmatch(session_id) or not await self.repository.revoke_panel_session_by_id(session_id, self.origin, self.epoch):
            raise DomainError("PANEL_SESSION_NOT_FOUND", "That browser is no longer paired", 404)
