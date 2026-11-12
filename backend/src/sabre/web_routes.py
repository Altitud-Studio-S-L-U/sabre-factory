"""Serve only known console routes as the SPA entry point, with an explicit cache policy."""

import json
import re
from pathlib import Path

from starlette.staticfiles import StaticFiles

_SECTION = re.compile(r"[a-z][a-z0-9-]{0,31}")


def console_sections() -> tuple[str, ...]:
    """Sections from the shared route list; the console navigation is checked against the same file."""
    data = json.loads((Path(__file__).with_name("console_routes.json")).read_text(encoding="utf-8"))
    sections = tuple(data["sections"])
    if not sections or len(set(sections)) != len(sections) or not all(_SECTION.fullmatch(item) for item in sections):
        raise ValueError("console_routes.json must list unique lowercase section names")
    return sections


_ENTRY = re.compile(r"(?:work/[A-Za-z0-9_-]{1,100}|" + "|".join(map(re.escape, console_sections())) + r")/?")
# Hashed build output never changes in place; the entry document must be revalidated so a rebuilt image is
# picked up instead of a cached index that still points at an older bundle.
IMMUTABLE = "public, max-age=31536000, immutable"
REVALIDATE = "no-cache"


class ConsoleFiles(StaticFiles):
    async def get_response(self, path, scope):
        if scope["method"] in {"GET", "HEAD"} and _ENTRY.fullmatch(path):
            path = "index.html"
        response = await super().get_response(path, scope)
        if response.status_code in {200, 206, 304}:
            response.headers["Cache-Control"] = IMMUTABLE if path.startswith("assets/") else REVALIDATE
        return response
