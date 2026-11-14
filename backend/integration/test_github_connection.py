"""The GitHub connection against a synthetic GitHub and the real PostgreSQL instance."""

import json
from types import SimpleNamespace

import httpx
import pytest
from pydantic import SecretStr

from sabre.credentials import Credentials
from sabre.github_app import (
    CLIENT_SECRET,
    OPERATIONS,
    PRIVATE_KEY,
    ConnectionRequest,
    Conversion,
    GitHubConnection,
    InstallationChoice,
)
from sabre.integrations import GitHubRepositoryImport, IntegrationService, IntegrationStateChange
from sabre.models import Budget, DomainError, Project, WorkOrder
from sabre.publisher import GitHubPublisher
from sabre.repository import Repository
from sabre.security import SecretGuard
from sabre.settings import Settings
from tests.github_fixture import ACCOUNT, APP_ID, PEM, SLUG, MemoryVault, SyntheticGitHub
from tests.test_credentials import config

BROWSER, OTHER_BROWSER = "a" * 64, "b" * 64
ORIGIN = "http://127.0.0.1:8000"


class Clock:
    def __init__(self):
        self.now = 1_800_000_000.0

    def __call__(self):
        return self.now


@pytest.fixture
async def github():
    """A connection over the real database, an in-memory vault and a synthetic GitHub, cleaned before and after."""
    repository = Repository(Settings().database_url.get_secret_value())
    await repository.initialize()

    async def clean():
        async with repository.connection() as conn:
            await conn.execute("DELETE FROM github_connection")
            await conn.execute("DELETE FROM github_connection_states")
            await conn.execute("DELETE FROM integration_preferences WHERE id IN ('github.read','github.publish')")

    await clean()
    clock = Clock()
    remote, vault, guard = SyntheticGitHub(clock), MemoryVault(), SecretGuard()
    connection = GitHubConnection(repository, vault, guard, origin=ORIGIN, client=remote.transport(), clock=clock)
    yield SimpleNamespace(repository=repository, connection=connection, remote=remote, vault=vault, guard=guard, clock=clock)
    await clean()
    await repository.close()


async def registered(fixture):
    form = await fixture.connection.begin(BROWSER, ConnectionRequest(account="personal"))
    await fixture.connection.convert(BROWSER, Conversion(code="valid-code", state=form.state))
    return form


async def connected(fixture):
    await registered(fixture)
    return await fixture.connection.install(InstallationChoice(installation_id=7001))


async def stored(fixture) -> tuple[int, set[str]]:
    async with fixture.repository.connection() as conn:
        rows = await (await conn.execute("SELECT count(*) AS total FROM github_connection")).fetchone()
    return rows["total"], fixture.vault.active()


async def test_the_owner_connects_in_three_steps_and_nothing_is_pasted(github):
    assert (await github.connection.view()).state == "not_connected" and not await github.connection.active()
    personal = await github.connection.begin(BROWSER, ConnectionRequest(account="personal"))
    assert personal.action == f"https://github.com/settings/apps/new?state={personal.state}"
    manifest = json.loads(personal.manifest)
    # The instance has no public address: no webhook is delivered, and GitHub returns to the console's own origin.
    assert manifest["hook_attributes"]["active"] is False and manifest["public"] is False and manifest["default_events"] == []
    assert (manifest["url"], manifest["redirect_url"], manifest["setup_url"]) == (ORIGIN, f"{ORIGIN}/tools?github=registered", f"{ORIGIN}/tools?github=installed")
    assert manifest["default_permissions"] == {"contents": "write", "pull_requests": "write", "checks": "read", "statuses": "read", "workflows": "write"}
    assert manifest["name"].startswith("SABRE Factory ")
    organization = await github.connection.begin(BROWSER, ConnectionRequest(account="organization", organization="octo-fixture"))
    assert organization.action.startswith("https://github.com/organizations/octo-fixture/settings/apps/new?state=")
    with pytest.raises(DomainError) as unnamed:
        await github.connection.begin(BROWSER, ConnectionRequest(account="organization"))
    assert unnamed.value.code == "GITHUB_ORGANIZATION_REQUIRED"

    view = await github.connection.convert(BROWSER, Conversion(code="valid-code", state=personal.state))
    assert view.state == "registered" and view.account is None
    assert (view.app.slug, view.app.owner, view.install_url) == (SLUG, ACCOUNT, f"https://github.com/apps/{SLUG}/installations/new")
    # The key and the client secret are in the vault and nowhere in what the console receives.
    assert await stored(github) == (1, {PRIVATE_KEY, CLIENT_SECRET})
    assert "PRIVATE KEY" not in view.model_dump_json() and "synthetic-client-secret" not in view.model_dump_json()
    assert not await github.connection.active()

    view = await github.connection.install(InstallationChoice(installation_id=7001))
    assert view.state == "connected" and await github.connection.active()
    assert (view.account.login, view.account.type, view.account.repository_selection) == (ACCOUNT, "Organization", "selected")
    assert view.manage_url == f"https://github.com/organizations/{ACCOUNT}/settings/installations/7001"
    # A second app cannot be registered over the first.
    with pytest.raises(DomainError) as again:
        await github.connection.begin(BROWSER, ConnectionRequest(account="personal"))
    assert again.value.code == "GITHUB_ALREADY_CONNECTED"


async def test_a_state_is_used_once_by_the_browser_it_was_issued_to_within_the_hour(github):
    form = await github.connection.begin(BROWSER, ConnectionRequest(account="personal"))
    for browser, state in ((BROWSER, "forged-state-that-was-never-issued"), (OTHER_BROWSER, form.state)):
        with pytest.raises(DomainError) as refused:
            await github.connection.convert(browser, Conversion(code="valid-code", state=state))
        assert refused.value.code == "GITHUB_STATE_INVALID" and refused.value.status_code == 403
    # Neither attempt spent the code or left anything behind.
    assert await stored(github) == (0, set()) and "valid-code" in github.remote.codes
    expired = await github.connection.begin(BROWSER, ConnectionRequest(account="personal"))
    async with github.repository.connection() as conn:
        await conn.execute("UPDATE github_connection_states SET expires_at=clock_timestamp()-interval '1 second'")
    with pytest.raises(DomainError) as late:
        await github.connection.convert(BROWSER, Conversion(code="valid-code", state=expired.state))
    assert late.value.code == "GITHUB_STATE_INVALID"
    fresh = await github.connection.begin(BROWSER, ConnectionRequest(account="personal"))
    await github.connection.convert(BROWSER, Conversion(code="valid-code", state=fresh.state))
    # A replay of the state that already registered the app is refused before anything else happens.
    with pytest.raises(DomainError) as replay:
        await github.connection.convert(BROWSER, Conversion(code="valid-code", state=fresh.state))
    assert replay.value.code == "GITHUB_STATE_INVALID"


@pytest.mark.parametrize("failure, code", [("expired", "GITHUB_CODE_EXPIRED"), ("lost", "GITHUB_CONVERSION_UNCERTAIN"),
                                           ("unusable", "GITHUB_RESPONSE_INVALID"), ("vault", "VAULT_UNAVAILABLE")])
async def test_a_registration_that_fails_leaves_no_partial_credentials(github, failure, code):
    form = await github.connection.begin(BROWSER, ConnectionRequest(account="personal"))
    request = Conversion(code="valid-code", state=form.state)
    if failure == "expired":
        request = Conversion(code="expired-code", state=form.state)
    elif failure == "lost":
        github.remote.lose_conversion = True
    elif failure == "unusable":
        github.remote.conversion_pem = "-----BEGIN RSA PRIVATE KEY-----\nnot a key\n-----END RSA PRIVATE KEY-----\n"
    else:
        # The private key is stored, then the vault refuses the client secret.
        github.vault.fail_on = CLIENT_SECRET
    with pytest.raises(DomainError) as error:
        await github.connection.convert(BROWSER, request)
    assert error.value.code == code
    # No row, no active secret, and the state is spent: the owner starts again from the console.
    assert await stored(github) == (0, set())
    assert (await github.connection.view()).state == "not_connected"
    with pytest.raises(DomainError) as spent:
        await github.connection.convert(BROWSER, request)
    assert spent.value.code == "GITHUB_STATE_INVALID"
    if failure == "lost":
        # GitHub did register the app; the message tells the owner where to remove it.
        assert "delete it there" in error.value.message


async def test_an_installation_is_kept_only_when_the_app_itself_lists_it(github):
    await registered(github)
    github.remote.installations += [github.remote.installation(8002, "someone-else", app_id=999),
                                    github.remote.installation(8003, "suspended-org", suspended=True)]
    for spoofed in (9999, 8002, 8003):
        with pytest.raises(DomainError) as refused:
            await github.connection.install(InstallationChoice(installation_id=spoofed))
        assert refused.value.code == "GITHUB_INSTALLATION_UNKNOWN" and refused.value.status_code == 403
        assert (await github.connection.view()).state == "registered"
    # Without an identifier, the single installation the app lists is taken; two leave the choice to the owner.
    github.remote.installations.append(github.remote.installation(7002, "second-org"))
    assert (await github.connection.install()).state == "registered"
    github.remote.installations = [item for item in github.remote.installations if item["id"] != 7002]
    view = await github.connection.install()
    assert view.state == "connected" and view.account.login == ACCOUNT
    # A process whose vault does not hold the app's key cannot act as the app, whatever the database says.
    with pytest.raises(DomainError) as keyless:
        await GitHubConnection(github.repository, MemoryVault(), SecretGuard(), origin=ORIGIN, client=github.remote.transport()).install()
    assert keyless.value.code == "SECRET_NOT_CONFIGURED"
    await github.connection.disconnect()
    with pytest.raises(DomainError) as nothing:
        await github.connection.install()
    assert nothing.value.code == "GITHUB_NOT_REGISTERED"


async def test_each_operation_gets_a_token_for_one_repository_and_only_what_it_needs(github):
    await connected(github)
    read = await github.connection.credential("read", f"{ACCOUNT}/widgets")
    publish = await github.connection.credential("publish", f"{ACCOUNT}/widgets")
    issued = github.remote.tokens
    assert issued[read.token.get_secret_value()] == {"permissions": {"contents": "read"}, "repositories": [f"{ACCOUNT}/widgets"],
                                                     "expires": github.clock() + 3600}
    assert issued[publish.token.get_secret_value()]["permissions"] == {"contents": "write", "pull_requests": "write"}
    assert read.app and publish.app and read.token.get_secret_value() != publish.token.get_secret_value()
    # The token is in the current format, far longer than forty characters, and the guard knows it.
    assert read.token.get_secret_value().startswith(f"ghs_{APP_ID}_") and len(read.token.get_secret_value()) > 100
    with pytest.raises(DomainError):
        github.guard.check({"output": f"leaked {read.token.get_secret_value()}"})

    async with github.remote.transport() as client:
        def call(method, path, credential):
            return client.request(method, f"https://api.github.com{path}", json={} if method == "POST" else None,
                                  headers={"Authorization": f"Bearer {credential.token.get_secret_value()}", "X-GitHub-Api-Version": "2022-11-28"})

        # A read token reads its repository, cannot write to it and does not exist for another repository.
        assert (await call("GET", f"/repos/{ACCOUNT}/widgets", read)).status_code == 200
        assert (await call("POST", f"/repos/{ACCOUNT}/widgets/git/blobs", read)).status_code == 403
        assert (await call("GET", f"/repos/{ACCOUNT}/gadgets", read)).status_code == 404
        assert (await call("POST", f"/repos/{ACCOUNT}/gadgets/git/blobs", publish)).status_code == 404
        assert (await call("POST", f"/repos/{ACCOUNT}/widgets/git/blobs", publish)).status_code == 201

    # No operation declares more than the app was registered with, and none shares another's permissions by accident.
    assert OPERATIONS["read"] == {"contents": "read"} and "pull_requests" not in OPERATIONS["read"]
    for refused, code in ((("read", "octo-fixture/unknown"), "GITHUB_REPOSITORY_NOT_CONNECTED"), (("read", "another-owner/widgets"), "GITHUB_REPOSITORY_NOT_CONNECTED"),
                          (("read", "not a repository"), "REPOSITORY_NOT_ALLOWED"), (("administer", None), "GITHUB_OPERATION_UNKNOWN")):
        with pytest.raises(DomainError) as error:
            await github.connection.credential(*refused)
        assert error.value.code == code


async def test_a_token_is_reused_until_it_nears_its_hour_and_minted_again_when_github_refuses_it(github):
    await connected(github)
    first = await github.connection.credential("read", f"{ACCOUNT}/widgets")
    again = await github.connection.credential("read", f"{ACCOUNT}/Widgets")
    assert again.token.get_secret_value() == first.token.get_secret_value() and len(github.remote.tokens) == 1
    github.clock.now += 3600 - 60
    renewed = await github.connection.credential("read", f"{ACCOUNT}/widgets")
    assert renewed.token.get_secret_value() != first.token.get_secret_value() and len(github.remote.tokens) == 2
    renewed.forget()
    assert (await github.connection.credential("read", f"{ACCOUNT}/widgets")).token.get_secret_value() != renewed.token.get_secret_value()
    # Nothing about a token is ever written to the database.
    async with github.repository.connection() as conn:
        row = await (await conn.execute("SELECT * FROM github_connection")).fetchone()
    assert all("ghs_" not in str(value) for value in row.values())
    page = await github.connection.repositories()
    assert [(item.full_name, item.visibility, item.default_branch) for item in page.items] == [
        (f"{ACCOUNT}/gadgets", "public", "trunk"), (f"{ACCOUNT}/widgets", "private", "main")]
    assert (page.total, page.next_page) == (2, None)


def services(fixture, **pasted):
    cfg = config()
    vault = fixture.vault
    for identifier, value in pasted.items():
        vault.records[identifier.replace("_", ".")] = [1, value]
    credentials = Credentials(vault, cfg, fixture.guard)
    integrations = IntegrationService(fixture.repository, cfg, credentials, fixture.guard, client=fixture.remote.transport())
    credentials.integrations = integrations
    credentials.github_connection = fixture.connection
    return credentials, integrations


async def test_reading_and_importing_use_the_connection_and_a_disabled_capability_blocks_its_next_call(github):
    credentials, integrations = services(github, github_read="ghp_" + "p" * 36)
    # Until the app is installed the pasted token is used, exactly as before.
    pasted = await credentials.github("github.read", f"{ACCOUNT}/widgets")
    assert not pasted.app and pasted.token.get_secret_value() == "ghp_" + "p" * 36
    listed = {item.id: item for item in await integrations.list()}
    assert "GitHub App" not in listed["github.read"].access

    await connected(github)
    project = await integrations.github_import(GitHubRepositoryImport(owner=ACCOUNT, repository="widgets", name="Widgets",
                                                                      profile="python", gate_commands=[["python", "-m", "unittest"]]))
    assert (project.repository, project.default_branch) == (f"https://github.com/{ACCOUNT}/widgets", "main")
    (grant,) = github.remote.tokens.values()
    assert grant["permissions"] == {"contents": "read"} and grant["repositories"] == [f"{ACCOUNT}/widgets"]
    listed = {item.id: item for item in await integrations.list()}
    for identifier in ("github.read", "github.publish"):
        assert listed[identifier].credential_configured and f"GitHub App installed on {ACCOUNT}" in listed[identifier].access
    # Creating repositories is not done through the app: it keeps its own pasted token and says nothing else.
    assert "GitHub App" not in listed["github.create"].access

    await integrations.change_state("github.read", IntegrationStateChange(enabled=False, expected_revision=0))
    with pytest.raises(DomainError) as disabled:
        await credentials.github("github.read", f"{ACCOUNT}/widgets")
    assert disabled.value.code == "INTEGRATION_DISABLED"
    # The other capability keeps working: they are three switches, not one.
    assert (await credentials.github("github.publish", f"{ACCOUNT}/widgets")).app


def delivery():
    work = WorkOrder(project_id="p", mode="patch", objective="Correct the rounding", acceptance=["Totals match"], budget=Budget(max_cost_usd=1),
                     idempotency_key="github-connection-fixture")
    snapshot = {"base_commit": "e" * 40, "files": [{"path": "src/app.py", "content": "print('fixed')\n"}]}
    return work, snapshot


async def test_a_delivery_through_the_connection_is_committed_by_the_app_and_a_pasted_token_delivers_as_before(github):
    credentials, _ = services(github, github_publish="ghp_" + "q" * 36)
    work, snapshot = delivery()
    project = Project(id="p", name="Widgets", repository=f"https://github.com/{ACCOUNT}/widgets", profile="python", gate_commands=[["python", "-m", "unittest"]])

    class PastedGitHub(SyntheticGitHub):
        """The same GitHub, where the pasted token reaches every repository as a personal token does."""

        def grant(self, request):
            token = request.headers.get("authorization", "").removeprefix("Bearer ")
            return {"permissions": {"contents": "write", "pull_requests": "write"}, "repositories": list(self.repositories)} if token.startswith("ghp_") else super().grant(request)

    remote = PastedGitHub(github.clock)

    def publisher(client):
        return GitHubPublisher(SimpleNamespace(), "", client, credential_resolver=lambda repository: credentials.github("github.publish", repository))

    async with httpx.AsyncClient(transport=httpx.MockTransport(remote.handle), base_url="https://api.github.com") as client:
        assert await publisher(client).prepare_commit(work, project, snapshot) == "d" * 40
    # With the pasted token nothing changes: the commit names SABRE as author and committer.
    assert remote.commits[0]["verified"] is False and remote.commits[0]["request"]["author"]["name"] == "SABRE"

    await connected(github)
    async with httpx.AsyncClient(transport=httpx.MockTransport(github.remote.handle), base_url="https://api.github.com") as client:
        assert await publisher(client).prepare_commit(work, project, snapshot) == "d" * 40
        # A token GitHub stops accepting is dropped and minted again once, and the delivery goes through.
        github.remote.reject_next_token_use = True
        assert await publisher(client).prepare_commit(work, project, snapshot) == "d" * 40
    # Through the connection the commit carries no author, committer or signature, so GitHub signs it as the app.
    assert [item["verified"] for item in github.remote.commits] == [True, True]
    assert all({"author", "committer"}.isdisjoint(item["request"]) for item in github.remote.commits)
    grants = list(github.remote.tokens.values())
    assert len(grants) == 2 and all(item["permissions"] == {"contents": "write", "pull_requests": "write"} for item in grants)
    assert all(item["repositories"] == [f"{ACCOUNT}/widgets"] for item in grants)


async def test_disconnecting_forgets_the_app_and_falls_back_to_the_pasted_tokens(github):
    credentials, integrations = services(github, github_publish="ghp_" + "q" * 36)
    await connected(github)
    assert (await credentials.github("github.publish", f"{ACCOUNT}/widgets")).app
    view = await github.connection.disconnect()
    # Nothing is revoked on GitHub: the view keeps the link where the owner uninstalls or deletes the app.
    assert view.state == "not_connected" and view.app.slug == SLUG and view.manage_url.endswith("/settings/installations/7001")
    assert await stored(github) == (0, {"github.publish"})
    assert (await github.connection.view()).model_dump(exclude={"version"}) == {"state": "not_connected", "app": None, "account": None,
                                                                              "install_url": None, "manage_url": None}
    pasted = await credentials.github("github.publish", f"{ACCOUNT}/widgets")
    assert not pasted.app and pasted.token.get_secret_value() == "ghp_" + "q" * 36
    with pytest.raises(DomainError) as gone:
        await github.connection.credential("read", f"{ACCOUNT}/widgets")
    assert gone.value.code == "GITHUB_NOT_CONNECTED"
    assert PEM not in json.dumps([list(item) for item in github.vault.records.values()])


async def test_the_connection_is_started_from_a_paired_browser_and_its_state_is_read_by_the_owner(github):
    from sabre.api import create_app

    service = SimpleNamespace(repository=github.repository, queue=SimpleNamespace(github_connection=github.connection))
    application = create_app(service, SimpleNamespace(auth_token=SecretStr("owner-test-token-at-least-24"), allowed_origins=[ORIGIN]))
    owner = {"Authorization": "Bearer owner-test-token-at-least-24"}
    async with httpx.AsyncClient(transport=httpx.ASGITransport(application), base_url=ORIGIN) as client:
        assert (await client.get("/api/v1/github/connection")).status_code == 401
        assert (await client.get("/api/v1/github/connection", headers=owner)).json()["state"] == "not_connected"
        # The owner's token alone cannot start or finish the flow: it leaves through a browser and returns to it.
        for path, body in (("/api/v1/github/connection/manifest", {"account": "personal"}),
                           ("/api/v1/github/connection/conversion", {"code": "valid-code", "state": "s" * 43}),
                           ("/api/v1/github/connection/installation", {"installation_id": 7001})):
            refused = await client.post(path, json=body, headers=owner)
            assert (refused.status_code, refused.json()["code"]) == (401, "PANEL_SESSION_REQUIRED")
        assert (await client.post("/api/v1/github/connection/conversion", json={"code": "bad code", "state": "short"}, headers=owner)).status_code == 422
        await connected(github)
        view = (await client.get("/api/v1/github/connection", headers=owner)).json()
        assert view["state"] == "connected" and view["account"]["login"] == ACCOUNT
        page = (await client.get("/api/v1/github/connection/repositories", headers=owner)).json()
        assert [item["full_name"] for item in page["items"]] == [f"{ACCOUNT}/gadgets", f"{ACCOUNT}/widgets"]
        assert (await client.get("/api/v1/github/connection/repositories?page=0", headers=owner)).status_code == 422
        assert (await client.delete("/api/v1/github/connection", headers=owner)).json()["state"] == "not_connected"
