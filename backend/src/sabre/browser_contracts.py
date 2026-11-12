"""Registered synthetic previews and bounded semantic browser jobs."""

from typing import Literal

from pydantic import Field, field_validator

from sabre.contracts import StrictContract


def default_viewports() -> list[Literal["desktop", "mobile"]]:
    return ["desktop", "mobile"]


class BrowserPreview(StrictContract):
    version: Literal[1] = 1
    command: list[str] = Field(min_length=1, max_length=30)
    port: int = Field(ge=1024, le=65535, strict=True)
    synthetic_data: Literal[True]

    @field_validator("command")
    @classmethod
    def bounded_argv(cls, value):
        if any(not item or len(item) > 1024 or "\0" in item for item in value):
            raise ValueError("Use bounded preview argv without shell expansion")
        return value


class BrowserOperation(StrictContract):
    action: Literal["navigate", "click", "fill", "press", "expect_text", "expect_visible", "expect_focus"]
    target: str = Field(default="", max_length=200)
    role: Literal["button", "link", "textbox", "checkbox", "radio", "combobox", "heading", "tab"] = "button"
    value: str = Field(default="", max_length=1000)


class BrowserJob(StrictContract):
    version: Literal[1] = 1
    idempotency_key: str = Field(min_length=8, max_length=128, pattern=r"^[A-Za-z0-9:._-]+$")
    snapshot_digest: str = Field(pattern=r"^[a-f0-9]{64}$")
    viewports: list[Literal["desktop", "mobile"]] = Field(default_factory=default_viewports, min_length=1, max_length=2)
    operations: list[BrowserOperation] = Field(min_length=1, max_length=20)
    accessibility: bool = True
    trace: bool = True


class BrowserEvidence(StrictContract):
    kind: Literal["screenshot", "trace", "report"]
    digest: str = Field(pattern=r"^[a-f0-9]{64}$")
    media_type: str
    size: int = Field(ge=0, le=16000000)
    viewport: str | None = None
    review_required: bool = False


class BrowserReport(StrictContract):
    version: Literal[1] = 1
    evaluator: Literal["playwright-1.64.0+axe-core-4.11.0"] = "playwright-1.64.0+axe-core-4.11.0"
    snapshot_digest: str
    work_id: str
    passed: bool
    results: list[dict]
    artifacts: list[BrowserEvidence]
    visual_review: Literal["unavailable"] = "unavailable"
