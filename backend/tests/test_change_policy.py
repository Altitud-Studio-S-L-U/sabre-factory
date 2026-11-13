import base64
import json

import pytest

from sabre.change_policy import material_changes, select_manifests
from sabre.models import DomainError


def npm(dependencies=None, **values):
    return json.dumps({"name": "example-project", "dependencies": dependencies or {}} | values)


@pytest.mark.parametrize("after", ["1.2.4", "1.9.0", "1.1.0", "v1.2.3"])
def test_pinned_npm_patch_and_minor_changes_do_not_require_architecture_approval(after):
    assert material_changes({"package.json": npm({"react": "1.2.3"})}, {"package.json": npm({"react": after})}) == []


@pytest.mark.parametrize("after", ["2.0.0", "^1.2.3", "latest", "1.3.0-beta.1"])
def test_major_range_or_prerelease_dependency_changes_are_material(after):
    changes = material_changes({"package.json": npm({"react": "1.2.3"})}, {"package.json": npm({"react": after})})
    assert changes and "react" in changes[0]


def test_dependency_addition_and_removal_are_material():
    changes = material_changes({"package.json": npm({"old-lib": "1.2.3"})}, {"package.json": npm({"new-lib": "1.2.3"})})
    assert any("was added to" in item and "new-lib" in item for item in changes)
    assert any("was removed from" in item and "old-lib" in item for item in changes)


@pytest.mark.parametrize("key,value", [("packageManager", "pnpm@11.19.0"), ("engines", {"node": ">=24"}), ("type", "module"), ("scripts", {"test": "echo passed"}), ("workspaces", ["packages/*"])])
def test_runtime_package_manager_and_build_command_changes_are_material(key, value):
    assert material_changes({"package.json": npm()}, {"package.json": npm(**{key: value})})


def test_package_descriptions_format_and_dependency_order_do_not_change_authority():
    before = npm({"b": "2.1.0", "a": "1.0.0"}, description="Before")
    after = json.dumps(json.loads(npm({"a": "1.0.0", "b": "2.1.0"}, description="After")), indent=4)
    assert material_changes({"package.json": before}, {"package.json": after}) == []


def test_python_pinned_minor_updates_and_toml_formatting_are_not_material():
    before = '[project]\nname="demo"\ndescription="Before"\ndependencies=["requests==2.30.0", "click==8.1.0"]\n'
    after = '[project]\nname = "demo"\ndescription = "After"\ndependencies = ["click==8.2.1", "requests == 2.32.0"]\n[tool.ruff]\nline-length=100\n'
    assert material_changes({"pyproject.toml": before}, {"pyproject.toml": after}) == []


@pytest.mark.parametrize("after", ["requests==3.0.0", "requests>=2.30.0", "requests==1!2.30.0", 'requests==2.32.0; python_version>="3.14"', "requests[security]==2.32.0"])
def test_python_major_epoch_marker_extras_and_range_changes_are_material(after):
    before = '[project]\ndependencies=["requests==2.30.0"]'
    after = "[project]\ndependencies=" + json.dumps([after])
    assert material_changes({"pyproject.toml": before}, {"pyproject.toml": after})


@pytest.mark.parametrize("section,before,after", [
    ("project", 'requires-python=">=3.13"', 'requires-python=">=3.14"'),
    ("build-system", 'requires=["hatchling==1.27.0"]\nbuild-backend="hatchling.build"', 'requires=["setuptools==80.0.0"]\nbuild-backend="setuptools.build_meta"'),
    ("tool.uv", 'index-url="https://registry.example/old"', 'index-url="https://registry.example/new"'),
])
def test_python_runtime_build_backend_and_package_sources_are_material(section, before, after):
    assert material_changes({"pyproject.toml": f"[{section}]\n{before}"}, {"pyproject.toml": f"[{section}]\n{after}"})


def test_optional_dependencies_and_development_groups_are_parsed():
    before = '[project.optional-dependencies]\nweb=["fastapi==0.100.0"]\n[dependency-groups]\ndev=["pytest==8.1.0"]'
    after = '[project.optional-dependencies]\nweb=["fastapi==0.110.0"]\n[dependency-groups]\ndev=["pytest==8.2.0"]'
    assert material_changes({"pyproject.toml": before}, {"pyproject.toml": after}) == []
    assert material_changes({"pyproject.toml": before}, {"pyproject.toml": after.replace('pytest==8.2.0', 'pytest==9.0.0')})


def test_requirements_comments_continuations_and_hash_formatting_are_not_material():
    before = '# pinned dependencies\nrequests==2.30.0 \\\n  --hash=sha256:old\nclick==8.1.0\n'
    after = '# new comment\n\nrequests == 2.32.0 \\\n  --hash=sha256:new \\\n  --hash=sha256:another\nclick==8.2.0 # compatible\n'
    assert material_changes({"requirements.lock": before}, {"requirements.lock": after}) == []


def test_requirement_source_options_are_independent_of_comment_line_numbers():
    before = '--index-url https://packages.example/simple\nrequests==2.30.0'
    after = '# added comment\n\n--index-url https://packages.example/simple\nrequests==2.32.0'
    assert material_changes({"requirements.txt": before}, {"requirements.txt": after}) == []


@pytest.mark.parametrize("after", [
    'requests @ https://person:private-password@packages.example/wheel.whl',
    'requests @ git+ssh://person@code.example/project.git',
    'requests @ file:///private/location',
    'git+ssh://person@code.example/project.git#egg=requests',
    '-e ./local-project',
])
def test_requirement_source_changes_are_material_without_echoing_source_locations(after):
    changes = material_changes({"requirements.txt": "requests==2.30.0"}, {"requirements.txt": after})
    assert changes
    rendered = " ".join(changes)
    assert "private-password" not in rendered
    assert "packages.example" not in rendered
    assert "code.example" not in rendered
    assert "/private/location" not in rendered


@pytest.mark.parametrize("path", ["Dockerfile", "infra/Dockerfile.api", ".github/workflows/test.yml", ".gitlab-ci.yml", "compose.yml"])
def test_infrastructure_changes_are_material_and_do_not_echo_file_contents(path):
    changes = material_changes({path: "before"}, {path: "after with private input"})
    assert changes and path in changes[0]
    assert "private input" not in changes[0]
    assert material_changes({}, {path: "new"})
    assert material_changes({path: "old"}, {})


def test_normal_tests_and_documentation_are_not_material_manifests():
    assert material_changes({"tests/test_example.py": "old", "infra/README.md": "old"}, {"tests/test_example.py": "new", "infra/README.md": "new"}) == []


def test_selector_accepts_utf8_base64_and_nested_manifests_but_ignores_dependencies():
    snapshot = {"files": [
        {"path": "packages/app/package.json", "content": npm(), "encoding": "utf-8"},
        {"path": "pyproject.toml", "content": base64.b64encode(b"[project]\nname='demo'").decode(), "encoding": "base64"},
        {"path": "requirements/dev.txt", "content": "pytest==8.1.0", "encoding": "utf-8"},
        {"path": "node_modules/demo/package.json", "content": npm(), "encoding": "utf-8"},
        {"path": "tests/test_example.py", "content": "", "encoding": "utf-8"},
    ]}
    selected = select_manifests(snapshot)
    assert set(selected) == {"packages/app/package.json", "pyproject.toml", "requirements/dev.txt"}
    assert selected["pyproject.toml"] == "[project]\nname='demo'"


@pytest.mark.parametrize("path,content", [
    ("package.json", '{"dependencies": {"broken": '),
    ("package.json", '{"dependencies":{},"dependencies":{}}'),
    ("package.json", '{"description": NaN}'),
    ("package.json", '{"dependencies": {"bad": true}}'),
    ("pyproject.toml", '[project\ndependencies=[]'),
    ("pyproject.toml", '[project]\ndependencies="invalid"'),
    ("requirements.txt", 'not a valid requirement with private data'),
])
def test_invalid_manifests_fail_closed_without_echoing_input(path, content):
    with pytest.raises(DomainError) as error:
        material_changes({}, {path: content})
    assert error.value.code == "INVALID_MANIFEST"
    assert content not in str(error.value)


@pytest.mark.parametrize("entry", [
    {"path": "../package.json", "content": "{}"},
    {"path": "/package.json", "content": "{}"},
    {"path": ".", "content": "{}"},
    {"path": "package.json", "content": "bad-base64", "encoding": "base64"},
    {"path": "package.json", "content": "/w==", "encoding": "base64"},
])
def test_invalid_snapshot_paths_or_manifest_bytes_are_rejected(entry):
    with pytest.raises(DomainError) as error:
        select_manifests({"files": [entry]})
    assert error.value.code == "INVALID_MANIFEST"


def test_duplicate_snapshot_manifest_is_rejected():
    with pytest.raises(DomainError):
        select_manifests({"files": [{"path": "package.json", "content": "{}"}] * 2})


@pytest.mark.parametrize("path", [".nvmrc", ".node-version", ".python-version", ".tool-versions", ".npmrc", "pnpm-workspace.yaml", ".yarnrc.yml"])
def test_runtime_and_package_manager_files_are_selected_and_changes_require_permission(path):
    assert select_manifests({"files": [{"path": path, "content": "current"}]}) == {path: "current"}
    assert material_changes({path: "current"}, {path: "changed-private-source"})
    assert "changed-private-source" not in " ".join(material_changes({path: "current"}, {path: "changed-private-source"}))
    assert material_changes({}, {path: "current"})
    assert material_changes({path: "current"}, {})


@pytest.mark.parametrize("field", ["dependencies", "optional-dependencies", "requires-python"])
def test_dynamic_dependency_or_runtime_resolution_is_a_material_choice(field):
    assert material_changes({"pyproject.toml": "[project]\n"}, {"pyproject.toml": f'[project]\ndynamic=["{field}"]'})


def test_dynamic_metadata_does_not_expand_architecture_approval_scope():
    assert material_changes({"pyproject.toml": "[project]\n"}, {"pyproject.toml": '[project]\ndynamic=["description", "version"]'}) == []
