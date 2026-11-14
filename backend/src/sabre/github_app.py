"""One GitHub connection made from the console, instead of pasted tokens.

A GitHub App registered from a manifest needs no pasted secret, reaches only the repositories the
owner chooses and lets the factory ask, for each operation, for a token narrower than its
installation: one repository, and only the permissions that operation needs. The app's private key
and client secret live in the vault; installation tokens live in memory until they expire and are
never stored or logged.

Three steps, all started from a paired browser and finished within the hour GitHub allows:
the console posts a manifest to GitHub, GitHub returns a one-time code that is exchanged for the
app's credentials, and the owner installs the app on the repositories it may use. The installation
identifier that comes back through the browser is not trusted: only one the app itself lists is kept.
"""

import asyncio
import base64
import hashlib
import json
import re
import secrets
import time
from datetime import UTC, datetime
from typing import Any, Literal

import httpx
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding, rsa
from fastapi import FastAPI, Request
from pydantic import Field, SecretStr

from sabre.contracts import Contract
from sabre.models import DomainError, SecretUpsert

API = "https://api.github.com"
WEB = "https://github.com"
API_VERSION = "2022-11-28"
STATE_SECONDS = 3600
JWT_SECONDS = 540
TOKEN_MARGIN_SECONDS = 120
PRIVATE_KEY, CLIENT_SECRET = "github.app.private_key", "github.app.client_secret"
OWNER = r"^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$"
REPOSITORY = r"^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?/[A-Za-z0-9_.-]{1,100}$"

# What the app asks for when it is registered. `metadata` comes with any repository permission.
DEFAULT_PERMISSIONS = {"contents": "write", "pull_requests": "write", "checks": "read", "statuses": "read", "workflows": "write"}
# What each operation asks for on its own token: never more than it needs.
OPERATIONS: dict[str, dict[str, str]] = {
    "read": {"contents": "read"},
    "checks": {"checks": "read", "statuses": "read"},
    "publish": {"contents": "write", "pull_requests": "write"},
    "publish_workflows": {"contents": "write", "pull_requests": "write", "workflows": "write"},
}

GITHUB_CONNECTION_SCHEMA = """
CREATE TABLE github_connection(
 id text PRIMARY KEY CHECK(id='default'),
 app_id bigint NOT NULL, slug text NOT NULL, name text NOT NULL, client_id text NOT NULL,
 html_url text NOT NULL, owner_login text NOT NULL,
 installation_id bigint, account_login text, account_type text, repository_selection text, manage_url text,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp());
CREATE TABLE github_connection_states(
 state_hash text PRIMARY KEY, session_hash text NOT NULL,
 expires_at timestamptz NOT NULL, used_at timestamptz);
"""


class ConnectionRequest(Contract):
    account: Literal["personal", "organization"]
    organization: str | None = Field(default=None, pattern=OWNER)


class ManifestForm(Contract):
    """What the console posts to GitHub from the owner's browser: a form with one field."""

    action: str
    manifest: str
    state: str


class Conversion(Contract):
    code: str = Field(pattern=r"^[A-Za-z0-9_-]{1,200}$")
    state: str = Field(pattern=r"^[A-Za-z0-9_-]{20,200}$")


class InstallationChoice(Contract):
    installation_id: int = Field(gt=0, le=2**53, strict=True)


class GitHubApp(Contract):
    slug: str
    name: str
    url: str
    owner: str


class GitHubAccount(Contract):
    login: str
    type: str
    repository_selection: Literal["all", "selected"] | None


class GitHubConnectionView(Contract):
    version: Literal[1] = 1
    state: Literal["not_connected", "registered", "connected"] = Field(
        description="registered: the app exists and is not installed yet; connected: an installation the app lists is kept")
    app: GitHubApp | None = None
    account: GitHubAccount | None = None
    install_url: str | None = Field(default=None, description="Where the owner chooses the repositories the app may use")
    manage_url: str | None = Field(default=None, description="The installation's page on GitHub")


class ConnectedRepository(Contract):
    id: int
    full_name: str
    url: str
    default_branch: str | None
    visibility: Literal["public", "private"]


class ConnectedRepositories(Contract):
    items: list[ConnectedRepository]
    page: int
    next_page: int | None
    total: int


class GitHubCredential:
    """A token for one GitHub operation. ``app`` says it came from the connection, not from a pasted token."""

    def __init__(self, token: SecretStr, *, app: bool = False, forget=None):
        self.token, self.app, self._forget = token, app, forget

    def forget(self) -> None:
        """Drop a token GitHub refused, so the next request for the same operation mints a new one."""
        if self._forget is not None:
            self._forget()


def encoded(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode()


def signing_key(pem: str) -> rsa.RSAPrivateKey:
    try:
        key = serialization.load_pem_private_key(pem.encode(), password=None)
    except (ValueError, TypeError, UnicodeEncodeError):
        raise DomainError("GITHUB_APP_KEY_INVALID", "The GitHub App key is not a private key the factory can sign with", 502) from None
    if not isinstance(key, rsa.RSAPrivateKey):
        raise DomainError("GITHUB_APP_KEY_INVALID", "The GitHub App key is not a private key the factory can sign with", 502)
    return key


def app_jwt(client_id: str, pem: str, now: float) -> str:
    """A short-lived token that proves the factory is the app: RS256, issued a minute ago, under ten minutes."""
    header = encoded(json.dumps({"alg": "RS256", "typ": "JWT"}, separators=(",", ":")).encode())
    claims = encoded(json.dumps({"iat": int(now) - 60, "exp": int(now) + JWT_SECONDS, "iss": client_id}, separators=(",", ":")).encode())
    signature = signing_key(pem).sign(f"{header}.{claims}".encode(), padding.PKCS1v15(), hashes.SHA256())
    return f"{header}.{claims}.{encoded(signature)}"


def text(value: Any, pattern: str, limit: int = 200) -> str:
    if not isinstance(value, str) or len(value) > limit or not re.fullmatch(pattern, value):
        raise ValueError
    return value


class GitHubConnection:
    def __init__(self, repository, vault, guard, *, origin: str, client: httpx.AsyncClient | None = None, clock=time.time):
        self.repository, self.vault, self.guard = repository, vault, guard
        self.origin = origin.rstrip("/")
        self.client, self.clock = client, clock
        # (installation, operation, repository) -> (token, expiry as epoch seconds). Memory only.
        self._tokens: dict[tuple[int, str, str | None], tuple[str, float]] = {}
        self._lock = asyncio.Lock()

    # -- transport -----------------------------------------------------------------------------

    async def _send(self, method: str, path: str, *, authorization: str | None = None, body: dict | None = None, params: dict | None = None):
        headers = {"Accept": "application/vnd.github+json", "X-GitHub-Api-Version": API_VERSION}
        if authorization:
            headers["Authorization"] = f"Bearer {authorization}"

        async def request(client):
            response = await client.request(method, f"{API}{path}", headers=headers, json=body, params=params, follow_redirects=False)
            if len(response.content) > 2_000_000:
                raise ValueError
            return response.status_code, (response.json() if response.content else None)

        async with asyncio.timeout(20):
            if self.client is not None:
                return await request(self.client)
            async with httpx.AsyncClient(timeout=15, trust_env=False) as client:
                return await request(client)

    # -- stored state --------------------------------------------------------------------------

    async def _row(self) -> dict | None:
        async with self.repository.connection() as conn:
            return await (await conn.execute("SELECT * FROM github_connection WHERE id='default'")).fetchone()

    async def active(self) -> bool:
        """True once an installation the app lists is kept: the three capabilities then use it."""
        row = await self._row()
        return bool(row and row["installation_id"])

    @staticmethod
    def _view(row: dict | None) -> GitHubConnectionView:
        if row is None:
            return GitHubConnectionView(state="not_connected")
        app = GitHubApp(slug=row["slug"], name=row["name"], url=row["html_url"], owner=row["owner_login"])
        install = f"{WEB}/apps/{row['slug']}/installations/new"
        if not row["installation_id"]:
            return GitHubConnectionView(state="registered", app=app, install_url=install)
        return GitHubConnectionView(
            state="connected", app=app, install_url=install, manage_url=row["manage_url"],
            account=GitHubAccount(login=row["account_login"], type=row["account_type"], repository_selection=row["repository_selection"]))

    async def view(self) -> GitHubConnectionView:
        return self._view(await self._row())

    # -- step 1: the manifest ------------------------------------------------------------------

    async def begin(self, session_hash: str, request: ConnectionRequest) -> ManifestForm:
        if request.account == "organization" and not request.organization:
            raise DomainError("GITHUB_ORGANIZATION_REQUIRED", "Name the organization that will own the app", 422)
        if await self._row() is not None:
            raise DomainError("GITHUB_ALREADY_CONNECTED", "A GitHub App is already registered; disconnect it before registering another", 409)
        state = secrets.token_urlsafe(32)
        async with self.repository.connection() as conn:
            await conn.execute("DELETE FROM github_connection_states WHERE expires_at<clock_timestamp() OR used_at IS NOT NULL")
            await conn.execute(
                "INSERT INTO github_connection_states(state_hash,session_hash,expires_at) VALUES(%s,%s,clock_timestamp()+make_interval(secs=>%s))",
                (hashlib.sha256(state.encode()).hexdigest(), session_hash, STATE_SECONDS))
        manifest = {
            # App names are unique across GitHub; the suffix keeps two instances from colliding.
            "name": f"SABRE Factory {secrets.token_hex(3)}",
            "url": self.origin,
            # The instance has no public address: webhook delivery is off, and the address is only a required field.
            "hook_attributes": {"url": f"{self.origin}/github/webhook-disabled", "active": False},
            "redirect_url": f"{self.origin}/tools?github=registered",
            "setup_url": f"{self.origin}/tools?github=installed",
            "public": False,
            "default_permissions": DEFAULT_PERMISSIONS,
            "default_events": [],
        }
        target = f"/organizations/{request.organization}/settings/apps/new" if request.account == "organization" else "/settings/apps/new"
        return ManifestForm(action=f"{WEB}{target}?state={state}", manifest=json.dumps(manifest, separators=(",", ":")), state=state)

    # -- step 2: the one-time code -------------------------------------------------------------

    async def _consume(self, session_hash: str, state: str) -> None:
        """A state is used once, by the browser it was issued to, within the hour."""
        async with self.repository.connection() as conn:
            row = await (await conn.execute(
                "UPDATE github_connection_states SET used_at=clock_timestamp() WHERE state_hash=%s AND session_hash=%s"
                " AND used_at IS NULL AND expires_at>clock_timestamp() RETURNING state_hash",
                (hashlib.sha256(state.encode()).hexdigest(), session_hash))).fetchone()
        if row is None:
            raise DomainError("GITHUB_STATE_INVALID", "This return from GitHub does not belong to a connection started in this browser; start again", 403)

    async def convert(self, session_hash: str, request: Conversion) -> GitHubConnectionView:
        await self._consume(session_hash, request.state)
        if await self._row() is not None:
            raise DomainError("GITHUB_ALREADY_CONNECTED", "A GitHub App is already registered; disconnect it before registering another", 409)
        try:
            status, data = await self._send("POST", f"/app-manifests/{request.code}/conversions")
        except (TimeoutError, httpx.HTTPError, ValueError, RecursionError):
            # GitHub may have registered the app: the code is spent and the key was never received.
            raise DomainError("GITHUB_CONVERSION_UNCERTAIN",
                "GitHub did not answer the registration. If the app appears in your GitHub App settings, delete it there, then connect again",
                502) from None
        if status in {404, 422}:
            raise DomainError("GITHUB_CODE_EXPIRED", "The registration code expired or was already used; connect again", 409)
        try:
            if status != 201 or not isinstance(data, dict):
                raise ValueError
            app_id = data["id"]
            if type(app_id) is not int or app_id <= 0:
                raise ValueError
            slug = text(data["slug"], r"[A-Za-z0-9-]{1,100}")
            name = text(data["name"], r"[^\x00-\x1f]{1,200}")
            client_id = text(data["client_id"], r"[A-Za-z0-9._-]{1,100}")
            html_url = text(data["html_url"], r"https://github\.com/[A-Za-z0-9/_.-]{1,200}")
            owner = text(data["owner"]["login"], OWNER.strip("^$"))
            pem, client_secret = data["pem"], data["client_secret"]
            if not isinstance(pem, str) or not isinstance(client_secret, str) or not client_secret or len(pem) > 16384:
                raise ValueError
            signing_key(pem)
        except (KeyError, TypeError, ValueError, DomainError):
            raise DomainError("GITHUB_RESPONSE_INVALID", "GitHub registered the app but its answer could not be used; delete the app on GitHub and connect again", 502) from None
        await self._store(app_id, slug, name, client_id, html_url, owner, pem, client_secret)
        return await self.view()

    async def _put(self, identifier: str, value: str) -> None:
        current = next((row.version for row in await self.vault.list_metadata() if row.id == identifier), None)
        await self.vault.put(identifier, SecretUpsert(value=SecretStr(value), expected_version=current))

    async def _clear_secrets(self) -> None:
        for row in await self.vault.list_metadata():
            if row.id in {PRIVATE_KEY, CLIENT_SECRET} and row.configured:
                await self.vault.deactivate(row.id, row.version)

    async def _store(self, app_id, slug, name, client_id, html_url, owner, pem, client_secret) -> None:
        """Keep the app whole or not at all: the key, the client secret and the row that names them."""
        try:
            await self._put(PRIVATE_KEY, pem)
            await self._put(CLIENT_SECRET, client_secret)
            async with self.repository.connection() as conn:
                await conn.execute(
                    "INSERT INTO github_connection(id,app_id,slug,name,client_id,html_url,owner_login) VALUES('default',%s,%s,%s,%s,%s,%s)",
                    (app_id, slug, name, client_id, html_url, owner))
        except BaseException:
            await self._clear_secrets()
            raise
        self.guard.known_secrets = tuple(dict.fromkeys((*self.guard.known_secrets, client_secret)))

    # -- step 3: the installation --------------------------------------------------------------

    async def _app_token(self, row: dict) -> str:
        return app_jwt(row["client_id"], (await self.vault.resolve(PRIVATE_KEY)).get_secret_value(), self.clock())

    async def _installations(self, row: dict) -> list[dict]:
        try:
            status, data = await self._send("GET", "/app/installations", authorization=await self._app_token(row), params={"per_page": 100})
        except (TimeoutError, httpx.HTTPError, ValueError, RecursionError):
            raise DomainError("GITHUB_UNAVAILABLE", "GitHub did not answer; try again", 502) from None
        if status == 401:
            raise DomainError("GITHUB_APP_REJECTED", "GitHub no longer accepts this app; disconnect and connect again", 409)
        if status != 200 or not isinstance(data, list):
            raise DomainError("GITHUB_RESPONSE_INVALID", "GitHub did not return the app's installations", 502)
        return [item for item in data if isinstance(item, dict)]

    async def install(self, choice: InstallationChoice | None = None) -> GitHubConnectionView:
        """Keep an installation the app itself lists. The identifier a browser brings is only a hint."""
        row = await self._row()
        if row is None:
            raise DomainError("GITHUB_NOT_REGISTERED", "Register the GitHub App before installing it", 409)
        candidates = [item for item in await self._installations(row)
                      if item.get("app_id") == row["app_id"] and type(item.get("id")) is int and not item.get("suspended_at")]
        if choice is not None:
            found = next((item for item in candidates if item["id"] == choice.installation_id), None)
            if found is None:
                raise DomainError("GITHUB_INSTALLATION_UNKNOWN", "This installation does not belong to the factory's GitHub App", 403)
        elif len(candidates) == 1:
            found = candidates[0]
        else:
            # Nothing installed yet, or several: the owner chooses on GitHub and returns.
            return self._view(row)
        try:
            account = found["account"]
            login = text(account["login"], OWNER.strip("^$"))
            kind = text(account["type"], r"[A-Za-z]{1,40}")
            selection = found.get("repository_selection")
            selection = selection if selection in {"all", "selected"} else None
            manage = text(found["html_url"], r"https://github\.com/[A-Za-z0-9/_.-]{1,200}")
        except (KeyError, TypeError, ValueError):
            raise DomainError("GITHUB_RESPONSE_INVALID", "GitHub did not describe the installation", 502) from None
        async with self.repository.connection() as conn:
            await conn.execute(
                "UPDATE github_connection SET installation_id=%s,account_login=%s,account_type=%s,repository_selection=%s,manage_url=%s,"
                "updated_at=clock_timestamp() WHERE id='default'", (found["id"], login, kind, selection, manage))
        self._tokens.clear()
        return await self.view()

    async def disconnect(self) -> GitHubConnectionView:
        """Forget the app. Nothing is revoked on GitHub: the owner uninstalls or deletes it there."""
        row = await self._row()
        async with self.repository.connection() as conn:
            await conn.execute("DELETE FROM github_connection WHERE id='default'")
            await conn.execute("DELETE FROM github_connection_states")
        await self._clear_secrets()
        self._tokens.clear()
        previous = self._view(row)
        return GitHubConnectionView(state="not_connected", app=previous.app, manage_url=previous.manage_url)

    # -- tokens --------------------------------------------------------------------------------

    def _forget(self, key: tuple[int, str, str | None]):
        def forget():
            self._tokens.pop(key, None)
        return forget

    async def credential(self, operation: str, repository: str | None = None) -> GitHubCredential:
        """A token for one operation, on one repository when the caller names it, valid for at most an hour."""
        if operation not in OPERATIONS:
            raise DomainError("GITHUB_OPERATION_UNKNOWN", "This GitHub operation has no declared permissions", 500)
        if repository is not None and not re.fullmatch(REPOSITORY, repository):
            raise DomainError("REPOSITORY_NOT_ALLOWED", "Use the owner and name of a GitHub repository", 422)
        row = await self._row()
        if row is None or not row["installation_id"]:
            raise DomainError("GITHUB_NOT_CONNECTED", "Connect GitHub and install the app on a repository first", 409)
        key = (row["installation_id"], operation, repository.casefold() if repository else None)
        async with self._lock:
            cached = self._tokens.get(key)
            if cached and cached[1] - TOKEN_MARGIN_SECONDS > self.clock():
                return GitHubCredential(SecretStr(cached[0]), app=True, forget=self._forget(key))
            body: dict[str, Any] = {"permissions": OPERATIONS[operation]}
            if repository:
                if repository.split("/")[0].casefold() != row["account_login"].casefold():
                    raise DomainError("GITHUB_REPOSITORY_NOT_CONNECTED", "The GitHub App is not installed on the account that owns this repository", 409)
                body["repositories"] = [repository.split("/")[1]]
            try:
                status, data = await self._send("POST", f"/app/installations/{row['installation_id']}/access_tokens",
                                                authorization=await self._app_token(row), body=body)
            except (TimeoutError, httpx.HTTPError, ValueError, RecursionError):
                raise DomainError("GITHUB_UNAVAILABLE", "GitHub did not answer; try again", 502) from None
            if status in {403, 404, 422}:
                raise DomainError("GITHUB_REPOSITORY_NOT_CONNECTED",
                    "The GitHub App cannot reach this repository with these permissions; review the installation on GitHub", 409)
            try:
                if status != 201 or not isinstance(data, dict):
                    raise ValueError
                token = data["token"]
                if not isinstance(token, str) or not token or len(token) > 8192:
                    raise ValueError
                expires = datetime.fromisoformat(data["expires_at"].replace("Z", "+00:00")).astimezone(UTC).timestamp()
            except (KeyError, TypeError, ValueError, AttributeError):
                raise DomainError("GITHUB_RESPONSE_INVALID", "GitHub did not return an installation token", 502) from None
            # Known to the guard for as long as the process lives, so it cannot leave in a result or a log.
            self.guard.known_secrets = tuple(dict.fromkeys((*self.guard.known_secrets, token)))
            now = self.clock()
            self._tokens = {name: value for name, value in self._tokens.items() if value[1] > now}
            self._tokens[key] = (token, expires)
            return GitHubCredential(SecretStr(token), app=True, forget=self._forget(key))

    async def repositories(self, page: int = 1) -> ConnectedRepositories:
        """The repositories the installation reaches, as GitHub lists them for its own token."""
        credential = await self.credential("read")
        try:
            status, data = await self._send("GET", "/installation/repositories", authorization=credential.token.get_secret_value(),
                                            params={"per_page": 30, "page": page})
        except (TimeoutError, httpx.HTTPError, ValueError, RecursionError):
            raise DomainError("GITHUB_UNAVAILABLE", "GitHub did not answer; try again", 502) from None
        if status == 401:
            credential.forget()
            raise DomainError("GITHUB_UNAVAILABLE", "GitHub refused the installation token; try again", 502)
        try:
            if status != 200 or not isinstance(data, dict) or type(data["total_count"]) is not int or not isinstance(data["repositories"], list):
                raise ValueError
            items = []
            for item in data["repositories"][:30]:
                full_name = text(item["full_name"], REPOSITORY.strip("^$"), 140)
                branch = item.get("default_branch") or None
                if type(item["id"]) is not int or type(item["private"]) is not bool or (branch is not None and (not isinstance(branch, str) or len(branch) > 255)):
                    raise ValueError
                items.append(ConnectedRepository(id=item["id"], full_name=full_name, url=f"{WEB}/{full_name}", default_branch=branch,
                                                 visibility="private" if item["private"] else "public"))
        except (KeyError, TypeError, ValueError):
            raise DomainError("GITHUB_RESPONSE_INVALID", "GitHub did not return a valid repository page", 502) from None
        self.guard.check([item.model_dump() for item in items])
        return ConnectedRepositories(items=items, page=page, total=data["total_count"],
                                     next_page=page + 1 if page * 30 < data["total_count"] and page < 100 else None)


def install_github_routes(app: FastAPI, service):
    from sabre.panel_sessions import COOKIE

    def connection() -> GitHubConnection:
        current = getattr(service().queue, "github_connection", None)
        if current is None:
            raise DomainError("GITHUB_CONNECTION_UNAVAILABLE", "The GitHub connection is not available on this instance", 503)
        return current

    def browser(request: Request) -> str:
        # The flow leaves through the owner's browser and must return to the same one.
        if not hasattr(request.state, "panel_session"):
            raise DomainError("PANEL_SESSION_REQUIRED", "Connect GitHub from the console in a paired browser", 401)
        return hashlib.sha256(request.cookies.get(COOKIE, "").encode()).hexdigest()

    @app.get("/api/v1/github/connection", response_model=GitHubConnectionView)
    async def github_connection():
        return await connection().view()

    @app.post("/api/v1/github/connection/manifest", response_model=ManifestForm)
    async def github_manifest(request: Request, body: ConnectionRequest):
        return await connection().begin(browser(request), body)

    @app.post("/api/v1/github/connection/conversion", response_model=GitHubConnectionView)
    async def github_conversion(request: Request, body: Conversion):
        return await connection().convert(browser(request), body)

    @app.post("/api/v1/github/connection/installation", response_model=GitHubConnectionView)
    async def github_installation(request: Request, body: InstallationChoice | None = None):
        browser(request)
        return await connection().install(body)

    @app.delete("/api/v1/github/connection", response_model=GitHubConnectionView)
    async def github_disconnect():
        return await connection().disconnect()

    @app.get("/api/v1/github/connection/repositories", response_model=ConnectedRepositories)
    async def github_connected_repositories(page: int = 1):
        if not 1 <= page <= 100:
            raise DomainError("INVALID_PAGE", "Use a page between 1 and 100", 422)
        return await connection().repositories(page)
