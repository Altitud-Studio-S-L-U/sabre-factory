from types import SimpleNamespace

import httpx
from pydantic import SecretStr

from sabre.api import create_app

ORIGINS = ["http://localhost:8000", "http://127.0.0.1:8000"]


def app(origins=ORIGINS):
    return create_app(object(), SimpleNamespace(auth_token=SecretStr("owner-test-token-at-least-24"), allowed_origins=origins))


async def test_localhost_pages_move_to_the_paired_host_with_path_and_query():
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app()), base_url="http://localhost:8000") as client:
        response = await client.get("/tools?connection=github.read")
        assert response.status_code == 308
        assert response.headers["location"] == "http://127.0.0.1:8000/tools?connection=github.read"
        root = await client.get("/")
        assert root.headers["location"] == "http://127.0.0.1:8000/"


async def test_api_health_and_writes_are_never_redirected():
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app()), base_url="http://localhost:8000") as client:
        assert (await client.get("/health")).status_code == 200
        assert (await client.get("/api/v1/status")).status_code == 401
        assert (await client.post("/work")).status_code != 308


async def test_other_hosts_and_unlisted_targets_are_left_alone():
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app()), base_url="http://127.0.0.1:8000") as client:
        assert (await client.get("/health")).status_code == 200
        assert (await client.get("/work")).status_code != 308
    only_localhost = app(["http://localhost:8000"])
    async with httpx.AsyncClient(transport=httpx.ASGITransport(only_localhost), base_url="http://localhost:8000") as client:
        assert (await client.get("/work")).status_code != 308
