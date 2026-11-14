"""A synthetic GitHub for the connection's tests: it registers an app from a code, lists its
installations to a valid app token only, and issues installation tokens that it then enforces
by repository and permission. Nothing here reaches the network.
"""

import base64
import json
import re
import secrets
from datetime import UTC, datetime, timedelta

import httpx
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding, rsa
from pydantic import SecretStr

from sabre.models import DomainError

# One key for the whole test session: generating one takes a noticeable fraction of a second.
KEY = rsa.generate_private_key(public_exponent=65537, key_size=2048)
PEM = KEY.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.TraditionalOpenSSL, serialization.NoEncryption()).decode()
APP_ID, CLIENT_ID, SLUG = 424242, "Iv23liSynthetic0001", "sabre-factory-a1b2c3"
ACCOUNT = "octo-fixture"


class MemoryVault:
    """The vault's contract in memory: versions are checked and a deactivated secret cannot be read."""

    def __init__(self):
        self.records: dict[str, list] = {}
        self.fail_on: str | None = None

    async def list_metadata(self):
        from types import SimpleNamespace

        return [SimpleNamespace(id=key, version=item[0], configured=item[1] is not None) for key, item in sorted(self.records.items())]

    async def put(self, identifier, request):
        if identifier == self.fail_on:
            raise DomainError("VAULT_UNAVAILABLE", "The vault did not accept the secret", 503)
        current = self.records.get(identifier)
        if (current is None and request.expected_version is not None) or (current is not None and current[0] != request.expected_version):
            raise DomainError("SECRET_VERSION_CONFLICT", "The secret changed", 409)
        self.records[identifier] = [current[0] + 1 if current else 1, request.value.get_secret_value()]

    async def deactivate(self, identifier, expected_version):
        current = self.records[identifier]
        if current[0] != expected_version:
            raise DomainError("SECRET_VERSION_CONFLICT", "The secret changed", 409)
        self.records[identifier] = [current[0] + 1, None]

    async def resolve(self, identifier):
        current = self.records.get(identifier)
        if not current or current[1] is None:
            raise DomainError("SECRET_NOT_CONFIGURED", "No active secret exists for this destination", 404)
        return SecretStr(current[1])

    def active(self) -> set[str]:
        return {key for key, item in self.records.items() if item[1] is not None}


def decoded(part: str) -> dict:
    return json.loads(base64.urlsafe_b64decode(part + "=" * (-len(part) % 4)))


class SyntheticGitHub:
    def __init__(self, clock):
        self.clock = clock
        self.codes = {"valid-code": "ok"}
        self.installations = [self.installation(7001, ACCOUNT)]
        self.repositories = {f"{ACCOUNT}/widgets": {"id": 501, "private": True, "default_branch": "main"},
                             f"{ACCOUNT}/gadgets": {"id": 502, "private": False, "default_branch": "trunk"}}
        self.tokens: dict[str, dict] = {}
        self.requests: list[tuple[str, str]] = []
        self.commits: list[dict] = []
        self.lose_conversion = False
        self.conversion_pem = PEM
        self.reject_next_token_use = False

    @staticmethod
    def installation(identifier: int, login: str, *, app_id: int = APP_ID, suspended: bool = False, selection: str = "selected") -> dict:
        return {"id": identifier, "app_id": app_id, "app_slug": SLUG, "repository_selection": selection,
                "account": {"login": login, "type": "Organization"}, "html_url": f"https://github.com/organizations/{login}/settings/installations/{identifier}",
                "suspended_at": "2026-11-01T00:00:00Z" if suspended else None}

    def transport(self) -> httpx.AsyncClient:
        return httpx.AsyncClient(transport=httpx.MockTransport(self.handle))

    # -- what GitHub checks ---------------------------------------------------------------------

    def app_authenticated(self, request: httpx.Request) -> bool:
        """A JWT signed by the app's key, issued by its client id, not yet expired and never longer than ten minutes."""
        try:
            header, claims, signature = request.headers["authorization"].removeprefix("Bearer ").split(".")
            KEY.public_key().verify(base64.urlsafe_b64decode(signature + "=" * (-len(signature) % 4)), f"{header}.{claims}".encode(),
                                    padding.PKCS1v15(), hashes.SHA256())
            values = decoded(claims)
            now = self.clock()
            return (decoded(header)["alg"] == "RS256" and values["iss"] == CLIENT_ID and values["iat"] <= now < values["exp"]
                    and values["exp"] - values["iat"] <= 600 and values["exp"] - now <= 600)
        except Exception:
            return False

    def grant(self, request: httpx.Request) -> dict | None:
        token = request.headers.get("authorization", "").removeprefix("Bearer ")
        grant = self.tokens.get(token)
        if grant is None or grant["expires"] <= self.clock():
            return None
        if self.reject_next_token_use:
            self.reject_next_token_use = False
            return None
        return grant

    def allowed(self, request: httpx.Request, repository: str, permission: str, level: str) -> httpx.Response | None:
        """None when the token may do this on this repository; otherwise the refusal GitHub would send."""
        grant = self.grant(request)
        if grant is None:
            return httpx.Response(401, json={"message": "Bad credentials"})
        if repository.casefold() not in {name.casefold() for name in grant["repositories"]}:
            return httpx.Response(404, json={"message": "Not Found"})
        held = grant["permissions"].get(permission)
        if held is None or (level == "write" and held != "write"):
            return httpx.Response(403, json={"message": "Resource not accessible by integration"})
        return None

    # -- the API --------------------------------------------------------------------------------

    def handle(self, request: httpx.Request) -> httpx.Response:
        path, method = request.url.path, request.method
        self.requests.append((method, path))
        if request.headers.get("x-github-api-version") != "2022-11-28":
            return httpx.Response(400, json={"message": "Missing API version"})
        conversion = re.fullmatch(r"/app-manifests/([^/]+)/conversions", path)
        if conversion and method == "POST":
            # A code is used once, whatever happens to the answer.
            if self.codes.pop(conversion[1], None) is None:
                return httpx.Response(404, json={"message": "Not Found"})
            if self.lose_conversion:
                raise httpx.ReadTimeout("the answer was lost")
            return httpx.Response(201, json={"id": APP_ID, "slug": SLUG, "name": "SABRE Factory a1b2c3", "client_id": CLIENT_ID,
                "client_secret": "synthetic-client-secret-0123456789", "webhook_secret": None, "pem": self.conversion_pem,
                "html_url": f"https://github.com/apps/{SLUG}", "owner": {"login": ACCOUNT, "type": "Organization"}})
        if path == "/app/installations" and method == "GET":
            return httpx.Response(200, json=self.installations) if self.app_authenticated(request) else httpx.Response(401, json={})
        tokens = re.fullmatch(r"/app/installations/(\d+)/access_tokens", path)
        if tokens and method == "POST":
            if not self.app_authenticated(request):
                return httpx.Response(401, json={})
            installation = next((item for item in self.installations if item["id"] == int(tokens[1]) and item["app_id"] == APP_ID), None)
            if installation is None:
                return httpx.Response(404, json={})
            body = json.loads(request.content)
            owner = installation["account"]["login"]
            reachable = [name for name in self.repositories if name.split("/")[0] == owner]
            names = [f"{owner}/{name}" for name in body.get("repositories", [])] or reachable
            if any(name not in reachable for name in names):
                return httpx.Response(422, json={"message": "There is at least one repository that does not exist or is not accessible"})
            # A current installation token: a prefix, the app id and a signed part, far longer than forty characters.
            token = f"ghs_{APP_ID}_{secrets.token_urlsafe(120)}"
            expires = datetime.fromtimestamp(self.clock(), UTC) + timedelta(hours=1)
            self.tokens[token] = {"permissions": body.get("permissions", {}), "repositories": names, "expires": expires.timestamp()}
            return httpx.Response(201, json={"token": token, "expires_at": expires.strftime("%Y-%m-%dT%H:%M:%SZ"), "permissions": body.get("permissions", {})})
        if path == "/installation/repositories" and method == "GET":
            grant = self.grant(request)
            if grant is None:
                return httpx.Response(401, json={})
            items = [{"id": self.repositories[name]["id"], "full_name": name, "name": name.split("/")[1], **self.repositories[name]}
                     for name in sorted(grant["repositories"])]
            return httpx.Response(200, json={"total_count": len(items), "repositories": items})
        repository = re.match(r"/repos/([^/]+/[^/]+)(/.*)?$", path)
        if repository:
            name, rest = repository[1], repository[2] or ""
            write = method != "GET"
            permission = "pull_requests" if rest.startswith("/pulls") and write else "contents"
            refused = self.allowed(request, name, permission, "write" if write else "read")
            if refused is not None:
                return refused
            if name not in self.repositories:
                return httpx.Response(404, json={})
            data = self.repositories[name]
            if rest == "" and method == "GET":
                return httpx.Response(200, json={"id": data["id"], "full_name": name, "private": data["private"], "archived": False,
                                                 "disabled": False, "default_branch": data["default_branch"], "description": "", "language": "Python"})
            if rest.startswith("/git/ref/heads/") and method == "GET":
                branch = rest.removeprefix("/git/ref/heads/")
                return httpx.Response(200, json={"object": {"sha": "e" * 40}}) if branch == data["default_branch"] else httpx.Response(404, json={})
            if rest.startswith("/git/trees/") and method == "GET":
                return httpx.Response(200, json={"sha": "f" * 40, "tree": [], "truncated": False})
            if rest == "/git/blobs" and method == "POST":
                return httpx.Response(201, json={"sha": "b" * 40})
            if rest == "/git/trees" and method == "POST":
                return httpx.Response(201, json={"sha": "c" * 40})
            if rest == "/git/commits" and method == "POST":
                body = json.loads(request.content)
                # GitHub signs a commit it creates for an app only when the request names no author, committer or signature.
                self.commits.append({"repository": name, "verified": not ({"author", "committer", "signature"} & set(body)), "request": body})
                return httpx.Response(201, json={"sha": "d" * 40})
        return httpx.Response(404, json={"message": "Not Found"})
