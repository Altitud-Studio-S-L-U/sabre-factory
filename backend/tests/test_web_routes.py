import httpx
import pytest
from starlette.applications import Starlette
from starlette.routing import Mount

from sabre.web_routes import IMMUTABLE, REVALIDATE, ConsoleFiles, console_sections


def console_app(tmp_path):
    (tmp_path / "index.html").write_text("<main>console fixture</main>")
    (tmp_path / "assets").mkdir()
    (tmp_path / "assets" / "index-abc123.js").write_text("console.log('fixture')")
    return Starlette(routes=[Mount("/", ConsoleFiles(directory=tmp_path, html=True))])


@pytest.mark.parametrize("path", ["/runs", "/runs/a-safe-id", "/work", "/work/a-safe-id", "/agents", "/tools", "/config", "/projects", "/memory",
    "/integrations", "/security/", "/about", "/tools?connection=github.read", "/config?section=models"])
async def test_console_deep_links_serve_entry(tmp_path, path):
    async with httpx.AsyncClient(transport=httpx.ASGITransport(console_app(tmp_path)), base_url="http://fixture") as client:
        response = await client.get(path)
    assert response.status_code == 200 and "console fixture" in response.text


@pytest.mark.parametrize("section", console_sections())
async def test_every_listed_console_section_serves_entry(tmp_path, section):
    async with httpx.AsyncClient(transport=httpx.ASGITransport(console_app(tmp_path)), base_url="http://fixture") as client:
        response = await client.get(f"/{section}")
    assert response.status_code == 200 and response.headers["cache-control"] == REVALIDATE


@pytest.mark.parametrize("path", ["/api/v1/unknown", "/mcp", "/internal/credentials", "/missing.js", "/work/a/b", "/runs/a/b", "/unknown"])
async def test_console_fallback_does_not_hide_missing_resources_or_service_paths(tmp_path, path):
    async with httpx.AsyncClient(transport=httpx.ASGITransport(console_app(tmp_path)), base_url="http://fixture") as client:
        response = await client.get(path)
    assert response.status_code == 404 and "console fixture" not in response.text
    assert "cache-control" not in response.headers


async def test_entry_is_revalidated_and_hashed_assets_are_immutable(tmp_path):
    async with httpx.AsyncClient(transport=httpx.ASGITransport(console_app(tmp_path)), base_url="http://fixture") as client:
        entry = await client.get("/work")
        asset = await client.get("/assets/index-abc123.js")
        conditional = await client.get("/work", headers={"If-None-Match": entry.headers["etag"]})
    assert entry.headers["cache-control"] == REVALIDATE
    assert asset.status_code == 200 and asset.headers["cache-control"] == IMMUTABLE
    assert conditional.status_code == 304 and conditional.headers["cache-control"] == REVALIDATE


async def test_missing_assets_are_not_cached(tmp_path):
    async with httpx.AsyncClient(transport=httpx.ASGITransport(console_app(tmp_path)), base_url="http://fixture") as client:
        response = await client.get("/assets/missing.js")
    assert response.status_code == 404 and "cache-control" not in response.headers
