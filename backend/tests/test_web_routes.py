import httpx
import pytest
from starlette.applications import Starlette
from starlette.routing import Mount

from sabre.web_routes import ConsoleFiles


@pytest.mark.parametrize("path", ["/work", "/work/a-safe-id", "/projects", "/memory", "/integrations", "/security/", "/about"])
async def test_console_deep_links_serve_entry(tmp_path, path):
    (tmp_path / "index.html").write_text("<main>console fixture</main>")
    app = Starlette(routes=[Mount("/", ConsoleFiles(directory=tmp_path, html=True))])
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="http://fixture") as client:
        response = await client.get(path)
    assert response.status_code == 200 and "console fixture" in response.text


@pytest.mark.parametrize("path", ["/api/v1/unknown", "/mcp", "/internal/credentials", "/missing.js", "/work/a/b", "/unknown"])
async def test_console_fallback_does_not_hide_missing_resources_or_service_paths(tmp_path, path):
    (tmp_path / "index.html").write_text("<main>console fixture</main>")
    app = Starlette(routes=[Mount("/", ConsoleFiles(directory=tmp_path, html=True))])
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="http://fixture") as client:
        response = await client.get(path)
    assert response.status_code == 404 and "console fixture" not in response.text
