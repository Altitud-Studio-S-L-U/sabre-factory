from types import SimpleNamespace

import pytest
from pydantic import ValidationError

from sabre.models import DomainError
from sabre.project_tools import ProjectToolsChange, ProjectToolService
from sabre.security import SecretGuard


@pytest.mark.parametrize("changes", [
    {"expected_revision": True}, {"expected_revision": -1}, {"expected_revision": "0"},
    {"servers": ["same", "same"]}, {"servers": ["../server"]}, {"servers": ["https://server"]},
    {"servers": ["a" * 41]}, {"servers": [str(index) for index in range(65)]}, {"servers": [True]},
])
def test_project_tool_changes_reject_invalid_revision_and_names(changes):
    with pytest.raises(ValidationError):
        ProjectToolsChange.model_validate({"expected_revision": 0, "servers": [], **changes})


async def test_known_secret_is_blocked_before_project_or_registry_access():
    secret = "synthetic-private-value"
    service = ProjectToolService(SimpleNamespace(), SimpleNamespace(), SecretGuard([secret]))
    with pytest.raises(DomainError) as error:
        await service.change("project", ProjectToolsChange(expected_revision=0, servers=[secret]))
    assert error.value.code == "SECRET_DETECTED"
