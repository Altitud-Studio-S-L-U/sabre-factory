"""The parts of the GitHub connection that need no database: the app token, token formats and the credential handed to callers."""

import base64
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock

import httpx
import pytest
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import padding
from pydantic import SecretStr

from sabre.credentials import Credentials
from sabre.github_app import JWT_SECONDS, GitHubCredential, app_jwt, signing_key
from sabre.models import DomainError
from sabre.private_credentials import fetch_credentials
from sabre.security import SecretGuard
from tests.github_fixture import CLIENT_ID, KEY, PEM, MemoryVault
from tests.test_credentials import config


def part(value: str) -> dict:
    return json.loads(base64.urlsafe_b64decode(value + "=" * (-len(value) % 4)))


def test_the_app_token_is_signed_with_the_apps_key_issued_a_minute_ago_and_lives_under_ten_minutes():
    now = 1_800_000_000
    header, claims, signature = app_jwt(CLIENT_ID, PEM, now).split(".")
    assert part(header) == {"alg": "RS256", "typ": "JWT"}
    # Issued by the client id, a minute in the past against clock drift, and under GitHub's ten-minute maximum.
    assert part(claims) == {"iat": now - 60, "exp": now + JWT_SECONDS, "iss": CLIENT_ID}
    assert JWT_SECONDS + 60 <= 600
    KEY.public_key().verify(base64.urlsafe_b64decode(signature + "=" * (-len(signature) % 4)), f"{header}.{claims}".encode(),
                            padding.PKCS1v15(), hashes.SHA256())
    assert "=" not in header + claims + signature


@pytest.mark.parametrize("pem", ["", "not a key", "-----BEGIN RSA PRIVATE KEY-----\nAAAA\n-----END RSA PRIVATE KEY-----\n",
                                 "-----BEGIN PUBLIC KEY-----\nAAAA\n-----END PUBLIC KEY-----\n"])
def test_a_key_the_factory_cannot_sign_with_is_refused_without_repeating_it(pem):
    with pytest.raises(DomainError) as error:
        signing_key(pem)
    assert error.value.code == "GITHUB_APP_KEY_INVALID" and "AAAA" not in error.value.message


@pytest.mark.parametrize("token", [
    "ghp_" + "a1B2" * 9,
    "gho_" + "a1B2" * 9,
    "ghu_" + "a1B2" * 9,
    "ghr_" + "a1B2" * 9,
    "ghs_" + "a1B2" * 9,
    "github_pat_" + "11AB" * 6 + "_" + "xY9z" * 14,
    # The installation token format GitHub is rolling out: the prefix, the app id and a signed part, hundreds of characters long.
    "ghs_424242_eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9." + "eyJpc3MiOiI0MjQyNDIifQ" * 6 + "." + "Zm9v-YmFy_" * 20,
])
def test_every_documented_github_token_format_is_recognised_by_its_prefix_whatever_its_length(token):
    guard = SecretGuard()
    for carrier in (token, f"Authorization: Bearer {token}", {"output": [f"remote: https://x-access-token:{token}@github.com/o/r"]}):
        with pytest.raises(DomainError) as error:
            guard.check(carrier)
        assert token not in error.value.message
    assert token not in guard.redact(f"the token was {token}.")


def test_ordinary_text_that_only_resembles_a_prefix_is_not_a_token():
    guard = SecretGuard()
    for harmless in ("ghs_short", "the ghost_story_of_the_long_haunted_house", "ghx_" + "a" * 40, "gh_" + "a" * 40):
        guard.check(harmless)


def test_a_credential_says_where_it_came_from_and_can_drop_a_refused_token():
    dropped = []
    from_app = GitHubCredential(SecretStr("ghs_1_token"), app=True, forget=lambda: dropped.append("forgotten"))
    from_app.forget()
    assert from_app.app and dropped == ["forgotten"]
    pasted = GitHubCredential(SecretStr("ghp_token"))
    pasted.forget()
    assert not pasted.app and "ghp_token" not in repr(pasted.token)


async def test_without_a_connection_or_before_it_is_installed_the_pasted_token_is_used():
    vault = MemoryVault()
    vault.records["github.publish"] = [1, "ghp_" + "q" * 36]
    credentials = Credentials(vault, config(), SecretGuard())
    assert (await credentials.github("github.publish", "octo-fixture/widgets")).token.get_secret_value() == "ghp_" + "q" * 36
    credentials.github_connection = SimpleNamespace(active=AsyncMock(return_value=False), credential=AsyncMock())
    pasted = await credentials.github("github.publish", "octo-fixture/widgets")
    assert not pasted.app and pasted.token.get_secret_value() == "ghp_" + "q" * 36
    credentials.github_connection.credential.assert_not_awaited()
    # Installed: reading and delivering ask the connection, naming the operation and the repository.
    minted = GitHubCredential(SecretStr("ghs_1_minted"), app=True)
    credentials.github_connection = SimpleNamespace(active=AsyncMock(return_value=True), credential=AsyncMock(return_value=minted))
    assert await credentials.github("github.read", "octo-fixture/widgets") is minted
    credentials.github_connection.credential.assert_awaited_once_with("read", "octo-fixture/widgets")
    # Creating a repository is not an operation of the app: it keeps its own pasted token.
    created = await credentials.github("github.create")
    assert not created.app and created.token.get_secret_value() == ""


async def test_the_executor_names_the_repository_it_is_about_to_read():
    seen = []

    async def handle(request):
        seen.append((request.url.path, dict(request.url.params), request.headers["authorization"]))
        return httpx.Response(200, json={"token": "ghs_1_for-one-repository"})

    async with httpx.AsyncClient(transport=httpx.MockTransport(handle), base_url="http://api") as client:
        answer = await fetch_credentials("http://api", "synthetic-broker-token", "github-read", client=client, repository="octo-fixture/widgets")
        await fetch_credentials("http://api", "synthetic-broker-token", "github-read", client=client)
    assert answer == {"token": "ghs_1_for-one-repository"}
    assert seen == [("/internal/credentials/github-read", {"repository": "octo-fixture/widgets"}, "Bearer synthetic-broker-token"),
                    ("/internal/credentials/github-read", {}, "Bearer synthetic-broker-token")]


async def test_the_control_answers_the_executor_with_a_credential_for_that_repository():
    from sabre.service import FactoryService

    credential = AsyncMock(return_value=GitHubCredential(SecretStr("ghs_1_for-one-repository"), app=True))
    service = FactoryService(None, None, None, SimpleNamespace(credentials=SimpleNamespace(github=credential)), SecretGuard(), config())
    assert await service.private_credentials("github-read", "octo-fixture/widgets") == {"token": "ghs_1_for-one-repository"}
    credential.assert_awaited_once_with("github.read", "octo-fixture/widgets")
