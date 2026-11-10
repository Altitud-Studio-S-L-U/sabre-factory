"""Model destination contract shared by global and per-flow configuration."""

from typing import Literal
from urllib.parse import urlsplit

from pydantic import ConfigDict, Field, model_validator

from sabre.contracts import Contract

Provider = Literal["codex_cli", "claude_cli", "openai", "anthropic", "google", "local"]
DESTINATIONS = {
    "codex_cli": "http://codex-runner:8091", "claude_cli": "http://claude-runner:8092",
    "openai": "https://api.openai.com/v1", "anthropic": "https://api.anthropic.com",
    "google": "https://generativelanguage.googleapis.com",
}
class ModelSelection(Contract):
    model_config = ConfigDict(strict=True, hide_input_in_errors=True)
    provider: Provider
    name: str = Field(default="", max_length=128, pattern=r"^[A-Za-z0-9._:/-]*$")
    destination: str = Field(min_length=1, max_length=2048)
    input_usd_per_million: float = Field(default=0, ge=0, le=1000000, allow_inf_nan=False)
    output_usd_per_million: float = Field(default=0, ge=0, le=1000000, allow_inf_nan=False)
    max_output_tokens: int = Field(default=4096, ge=128, le=32768, strict=True)

    @model_validator(mode="after")
    def explicit_destination(self):
        if self.provider != "local":
            if self.destination != DESTINATIONS[self.provider]:
                raise ValueError("The selected provider requires its explicit approved destination")
        else:
            try:
                parsed = urlsplit(self.destination)
                valid = parsed.scheme in {"http", "https"} and bool(parsed.hostname) and not (
                    parsed.username or parsed.password or parsed.query or parsed.fragment
                    or any(char.isspace() or ord(char) < 32 for char in self.destination)
                    or "\\" in self.destination
                )
                valid = valid and (parsed.port is None or 1 <= parsed.port <= 65535)
            except ValueError:
                valid = False
            if not valid:
                raise ValueError("Local models require an explicit HTTP(S) destination without credentials")
        return self
