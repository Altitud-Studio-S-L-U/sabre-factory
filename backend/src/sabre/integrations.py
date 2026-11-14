"""Owner-managed connection switches and bounded GitHub repository discovery."""

import asyncio
import json
import re
from typing import Literal

import httpx
from pydantic import Field, ValidationError, field_validator

from sabre.models import Contract, DomainError, ProjectCreate

INTEGRATIONS_SCHEMA = """
CREATE TABLE IF NOT EXISTS integration_preferences (
    id text PRIMARY KEY, enabled boolean NOT NULL, revision integer NOT NULL DEFAULT 0,
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE IF NOT EXISTS integration_events (
    id bigserial PRIMARY KEY, integration_id text NOT NULL, revision integer NOT NULL,
    enabled boolean NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
"""

OWNER_PATTERN = r"^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$"
REPO_PATTERN = r"^[A-Za-z0-9_.-]{1,100}$"


class IntegrationStateChange(Contract):
    enabled: bool = Field(strict=True)
    expected_revision: int = Field(ge=0, strict=True)


class IntegrationTool(Contract):
    name: str
    effect: str
    roles: list[str] = Field(default_factory=list)


class IntegrationInfo(Contract):
    id: str
    kind: Literal["github", "mcp", "model", "slack"]
    title: str
    description: str
    enabled: bool
    revision: int
    toggleable: bool
    credential_ids: list[str]
    credential_configured: bool
    access: str
    tools: list[IntegrationTool] = Field(default_factory=list)


class GitHubRepositorySearch(Contract):
    owner_type: Literal["user", "org"]
    owner: str = Field(pattern=OWNER_PATTERN)
    page: int = Field(default=1, ge=1, le=100, strict=True)


class GitHubRepositoryInfo(Contract):
    id: int = Field(gt=0, strict=True)
    full_name: str
    url: str
    default_branch: str | None
    visibility: Literal["public", "private"]
    archived: bool
    disabled: bool
    description: str
    language: str | None


class GitHubRepositoryPage(Contract):
    items: list[GitHubRepositoryInfo]
    page: int
    next_page: int | None
    access: Literal["public", "credential"]


class GitHubRepositoryImport(Contract):
    owner: str = Field(pattern=OWNER_PATTERN)
    repository: str = Field(pattern=REPO_PATTERN)
    name: str = Field(min_length=1, max_length=100)
    profile: Literal["python", "node"]
    gate_commands: list[list[str]] = Field(min_length=1, max_length=12)

    @field_validator("repository")
    @classmethod
    def repository_name(cls, value):
        if value in {".", ".."}:
            raise ValueError("Invalid repository name")
        return value


class IntegrationService:
    def __init__(self, repository, config, credentials, guard, *, client: httpx.AsyncClient | None = None):
        self.repository, self.config, self.credentials, self.guard = repository, config, credentials, guard
        self.client = client

    def _definitions(self):
        definitions = [
            ("github.read", "github", "GitHub · read repositories", "Browse repositories and import them as SABRE projects.", ["github.read"], [IntegrationTool(name="list_repositories", effect="read"), IntegrationTool(name="import_repository", effect="configuration")]),
            ("github.publish", "github", "GitHub · draft pull requests", "Pushes a branch and opens a draft pull request when the factory approves delivery.", ["github.publish"], [IntegrationTool(name="publish_draft_pr", effect="external_write")]),
            ("github.create", "github", "GitHub · create repositories", "Creates a repository only after a proposal and explicit owner approval.", ["github.create"], [IntegrationTool(name="create_repository", effect="external_write")]),
        ]
        for name, server in sorted(self.config.mcp_servers.items()):
            definitions.append((f"mcp.{name}", "mcp", f"MCP · {name}", "Authorized external tools for projects that select this server.", [self.credentials.mcp_ids[name]], [IntegrationTool(name=tool, effect=policy.effect, roles=sorted(policy.roles)) for tool, policy in sorted(server.tools.items())]))
        definitions.append(("model", "model", "Model providers", "Model selection and limits are stored in factory configuration.", sorted(identifier for identifier in self.credentials.targets if identifier.startswith("model.")), []))
        definitions.append(("slack", "slack", "Slack", "Owner channel; bot binding is configured on the instance.", ["slack.bot", "slack.app"], []))
        return definitions

    def _validate(self, identifier):
        definition = next((item for item in self._definitions() if item[0] == identifier), None)
        if definition is None:
            raise DomainError("INTEGRATION_NOT_FOUND", "The integration is not registered", 404)
        if definition[1] not in {"github", "mcp"}:
            raise DomainError("INTEGRATION_NOT_SWITCHABLE", "This connection is managed through instance configuration", 422)

    async def preference_revision(self):
        async with self.repository.connection() as conn:
            rows = await (await conn.execute("SELECT id, enabled, revision FROM integration_preferences ORDER BY id")).fetchall()
        return tuple((row["id"], row["enabled"], row["revision"]) for row in rows)

    async def list(self) -> list[IntegrationInfo]:
        preferences = {identifier: (enabled, revision) for identifier, enabled, revision in await self.preference_revision()}
        metadata = {row.id: row.configured for row in await self.credentials.vault.list_metadata()}
        result = []
        for identifier, kind, title, description, targets, tools in self._definitions():
            enabled, revision = preferences.get(identifier, (True, 0))
            configured = bool(targets) and (any(metadata.get(target, False) for target in targets) if kind == "model" else all(metadata.get(target, False) for target in targets))
            if identifier == "github.read":
                access = "Read credential saved; access depends on its permissions." if configured else "Public access; add a read credential for private repositories."
            elif kind == "mcp":
                access = "Credential saved; availability has not been checked." if configured else "No credential; the server must allow anonymous access."
            elif kind == "model" and ({self.config.model_provider, *(role.model_provider for role in self.config.role_models.values())} & {"codex_cli", "claude_cli"}):
                access = "CLI sessions and role models are managed in Models and team; API keys remain bound to their destinations."
            else:
                access = "Credential saved; permissions have not been checked." if configured else "Configuration or credentials are pending."
            result.append(IntegrationInfo(id=identifier, kind=kind, title=title, description=description, enabled=enabled, revision=revision, toggleable=kind in {"github", "mcp"}, credential_ids=targets, credential_configured=configured, access=access, tools=tools))
        self.guard.check([item.model_dump() for item in result])
        return result

    async def ensure_enabled(self, identifier):
        self._validate(identifier)
        async with self.repository.connection() as conn:
            row = await (await conn.execute("SELECT enabled FROM integration_preferences WHERE id=%s", (identifier,))).fetchone()
        if row and not row["enabled"]:
            raise DomainError("INTEGRATION_DISABLED", "The connection is disabled; enable it before continuing", 409)

    async def change_state(self, identifier: str, change: IntegrationStateChange) -> IntegrationInfo:
        self._validate(identifier)
        async with self.repository.connection() as conn:
            await conn.execute("INSERT INTO integration_preferences(id,enabled) VALUES(%s,true) ON CONFLICT DO NOTHING", (identifier,))
            row = await (await conn.execute("SELECT revision FROM integration_preferences WHERE id=%s FOR UPDATE", (identifier,))).fetchone()
            if row["revision"] != change.expected_revision:
                raise DomainError("INTEGRATION_CHANGED", "The connection changed; refresh its state before continuing", 409)
            revision = row["revision"] + 1
            await conn.execute("UPDATE integration_preferences SET enabled=%s,revision=%s,updated_at=clock_timestamp() WHERE id=%s", (change.enabled, revision, identifier))
            await conn.execute("INSERT INTO integration_events(integration_id,revision,enabled) VALUES(%s,%s,%s)", (identifier, revision, change.enabled))
        return next(item for item in await self.list() if item.id == identifier)

    async def _github_get(self, path: str, params=None, *, use_credentials=True):
        await self.ensure_enabled("github.read")
        token = (await self.credentials.resolve("github.read")).get_secret_value() if use_credentials else ""
        headers = {"Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28"}
        if token:
            headers["Authorization"] = f"Bearer {token}"

        async def request(client):
            async with client.stream("GET", f"https://api.github.com{path}", headers=headers, params=params, follow_redirects=False) as response:
                if response.status_code != 200:
                    code = "GITHUB_RATE_LIMIT" if response.status_code in {403, 429} and (response.headers.get("x-ratelimit-remaining") == "0" or response.status_code == 429) else "GITHUB_UNAVAILABLE"
                    raise DomainError(code, "GitHub denied repository listing; review access and try again later", 502)
                body = bytearray()
                async for chunk in response.aiter_bytes():
                    body.extend(chunk)
                    if len(body) > 2_000_000:
                        raise DomainError("GITHUB_RESPONSE_INVALID", "The GitHub response exceeds the size limit", 502)
                return json.loads(body)
        try:
            async with asyncio.timeout(15):
                if self.client:
                    data = await request(self.client)
                else:
                    async with httpx.AsyncClient(timeout=12, trust_env=False) as client:
                        data = await request(client)
        except (TimeoutError, httpx.HTTPError, ValueError, RecursionError):
            raise DomainError("GITHUB_UNAVAILABLE", "Could not verify the GitHub response", 502) from None
        await self.ensure_enabled("github.read")
        return data, bool(token)

    def _repository_info(self, value, owner: str) -> GitHubRepositoryInfo:
        try:
            if not isinstance(value, dict):
                raise ValueError
            full_name = value["full_name"]
            if not isinstance(full_name, str) or full_name.count("/") != 1:
                raise ValueError
            actual_owner, name = full_name.split("/")
            if actual_owner.casefold() != owner.casefold() or not re.fullmatch(OWNER_PATTERN, actual_owner) or not re.fullmatch(REPO_PATTERN, name) or name in {".", ".."}:
                raise ValueError
            if type(value["private"]) is not bool or type(value["archived"]) is not bool or type(value.get("disabled", False)) is not bool:
                raise ValueError
            branch = value.get("default_branch") or None
            if branch is not None and (not isinstance(branch, str) or len(branch) > 255):
                raise ValueError
            description, language = value.get("description") or "", value.get("language")
            if not isinstance(description, str) or len(description) > 4096 or (language is not None and (not isinstance(language, str) or len(language) > 100)):
                raise ValueError
            result = GitHubRepositoryInfo(id=value["id"], full_name=full_name, url=f"https://github.com/{full_name}", default_branch=branch, visibility="private" if value["private"] else "public", archived=value["archived"], disabled=value.get("disabled", False), description=description, language=language)
        except (KeyError, TypeError, ValueError, ValidationError):
            raise DomainError("GITHUB_RESPONSE_INVALID", "GitHub did not return a valid repository", 502) from None
        self.guard.check(result.model_dump())
        return result

    async def github_repositories(self, search: GitHubRepositorySearch) -> GitHubRepositoryPage:
        self.guard.check(search.model_dump())
        segment = "users" if search.owner_type == "user" else "orgs"
        data, authenticated = await self._github_get(f"/{segment}/{search.owner}/repos", {"type": "owner" if search.owner_type == "user" else "all", "sort": "full_name", "direction": "asc", "per_page": 30, "page": search.page}, use_credentials=search.owner_type == "org")
        if not isinstance(data, list) or len(data) > 30:
            raise DomainError("GITHUB_RESPONSE_INVALID", "GitHub did not return a valid repository page", 502)
        items = [self._repository_info(value, search.owner) for value in data]
        return GitHubRepositoryPage(items=items, page=search.page, next_page=search.page + 1 if len(items) == 30 and search.page < 100 else None, access="credential" if authenticated and search.owner_type == "org" else "public")

    async def github_import(self, request: GitHubRepositoryImport) -> ProjectCreate:
        self.guard.check(request.model_dump())
        data, _ = await self._github_get(f"/repos/{request.owner}/{request.repository}")
        info = self._repository_info(data, request.owner)
        if info.full_name.casefold() != f"{request.owner}/{request.repository}".casefold():
            raise DomainError("GITHUB_RESPONSE_INVALID", "The repository does not match the selection", 502)
        if info.archived or info.disabled or not info.default_branch:
            raise DomainError("GITHUB_REPOSITORY_INACTIVE", "Select an active repository with an initial branch", 422)
        try:
            return ProjectCreate(name=request.name, repository=info.url, profile=request.profile, gate_commands=request.gate_commands, default_branch=info.default_branch)
        except ValidationError:
            raise DomainError("PROJECT_INVALID", "Review the project profile, checks and branch", 422) from None
