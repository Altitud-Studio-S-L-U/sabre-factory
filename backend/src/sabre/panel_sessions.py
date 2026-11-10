"""Short-lived browser access granted by the authenticated local launcher."""

import hashlib
import hmac
import re
import secrets
from datetime import datetime
from urllib.parse import urlsplit

from pydantic import BaseModel, ConfigDict, Field, SecretStr

from sabre.models import DomainError

COOKIE = "sabre_panel_session"
COOKIE_PATH = "/api/v1"
DEFAULT_ORIGIN = "http://127.0.0.1:8000"
CAPABILITY = re.compile(r"[A-Za-z0-9_-]{43}\Z")


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


class PanelSessions:
    def __init__(self, repository, owner_token: str, origin: str):
        self.repository = repository
        self.origin = canonical_origin(origin)
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

    async def exchange(self, ticket: str):
        if not CAPABILITY.fullmatch(ticket):
            raise DomainError("SESSION_TICKET_INVALID", "The access link expired or has already been used", 401)
        session = secrets.token_urlsafe(32)
        expires = await self.repository.exchange_panel_ticket(self.hashed(ticket), self.hashed(session), self.origin, self.epoch)
        if expires is None:
            raise DomainError("SESSION_TICKET_INVALID", "The access link expired or has already been used", 401)
        return session, self.payload(session, expires)

    async def authenticate(self, request):
        session = request.cookies.get(COOKIE, "")
        if not CAPABILITY.fullmatch(session):
            raise DomainError("PANEL_SESSION_REQUIRED", "Open SABRE from its local launcher", 401)
        browser_context(request, self.origin, mutation=request.method not in {"GET", "HEAD"})
        expires = await self.repository.panel_session(self.hashed(session), self.origin, self.epoch)
        if expires is None:
            raise DomainError("PANEL_SESSION_REQUIRED", "The panel session expired; open SABRE again", 401)
        if request.method not in {"GET", "HEAD"} and not hmac.compare_digest(request.headers.get("x-csrf-token", "").encode(), self.csrf(session).encode()):
            raise DomainError("PANEL_CSRF_DENIED", "The request does not belong to this panel session", 403)
        return self.payload(session, expires)

    def payload(self, session: str, expires: datetime):
        return {"authenticated": True, "csrf_token": self.csrf(session), "expires_at": expires.isoformat()}

    async def revoke(self, request):
        await self.repository.revoke_panel_session(self.hashed(request.cookies[COOKIE]))
