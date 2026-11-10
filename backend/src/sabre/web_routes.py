"""Serve only known console routes as the SPA entry point."""

import re

from starlette.staticfiles import StaticFiles


class ConsoleFiles(StaticFiles):
    async def get_response(self, path, scope):
        if scope["method"] in {"GET", "HEAD"} and re.fullmatch(
            r"(?:work(?:/[A-Za-z0-9_-]{1,100})?|projects|security|memory|integrations|about)/?", path
        ):
            path = "index.html"
        return await super().get_response(path, scope)
