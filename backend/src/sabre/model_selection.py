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
# Every reasoning effort the factory can name, across providers.
Effort = Literal["low", "medium", "high", "xhigh", "max"]
# The levels each provider takes, for the providers where the factory sets one. A provider is listed
# once its levels are read from the pinned integration and the value was seen on the request that
# integration builds; until then a selection that names an effort for it is refused.
# The Claude CLI decides by model, and the native check holds what the pinned one does: without a
# level it asks for medium with claude-opus-5-5 and for high with claude-sonnet-4-6, it lowers a
# level the model does not have, and for a model without the setting it sends none.
EFFORT_LEVELS: dict[str, tuple[Effort, ...]] = {"claude_cli": ("low", "medium", "high", "xhigh", "max")}


class ModelSelection(Contract):
    model_config = ConfigDict(strict=True, hide_input_in_errors=True)
    provider: Provider
    name: str = Field(default="", max_length=128, pattern=r"^[A-Za-z0-9._:/-]*$")
    destination: str = Field(min_length=1, max_length=2048)
    input_usd_per_million: float = Field(default=0, ge=0, le=1000000, allow_inf_nan=False)
    output_usd_per_million: float = Field(default=0, ge=0, le=1000000, allow_inf_nan=False)
    # Prices of cached input. Left out, cached tokens are charged at the input price. They are
    # omitted from the serialized selection while unset, so earlier selections keep their form.
    cache_read_usd_per_million: float | None = Field(default=None, ge=0, le=1000000, allow_inf_nan=False,
                                                     exclude_if=lambda value: value is None)
    cache_write_usd_per_million: float | None = Field(default=None, ge=0, le=1000000, allow_inf_nan=False,
                                                      exclude_if=lambda value: value is None)
    max_output_tokens: int = Field(default=4096, ge=128, le=32768, strict=True)
    # How hard the model reasons, where the provider has such a setting. Left out, the provider decides,
    # and the selection keeps the form it had before this field existed.
    effort: Effort | None = Field(default=None, exclude_if=lambda value: value is None)

    @model_validator(mode="after")
    def known_effort(self):
        if self.effort is not None and self.effort not in EFFORT_LEVELS.get(self.provider, ()):
            levels = EFFORT_LEVELS.get(self.provider)
            raise ValueError(f"Effort for this provider is one of: {', '.join(levels)}" if levels
                             else "This provider takes no reasoning effort setting here")
        return self

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
