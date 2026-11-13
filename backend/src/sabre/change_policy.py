"""Static material-change detection for direct manifests and execution infrastructure.

Requirement files, including requirements.lock, are explicit deployment manifests.
Resolver-only files such as uv.lock and package-lock.json remain under gates and
security review; this module does not reconstruct their transitive resolution graph.
"""

import base64
import json
import re
import tomllib
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import PurePosixPath
from typing import Any

from packaging.requirements import InvalidRequirement, Requirement
from packaging.specifiers import InvalidSpecifier, SpecifierSet
from packaging.utils import canonicalize_name
from packaging.version import InvalidVersion, Version

from sabre.models import DomainError
from sabre.security import SecretGuard

_NPM_NAME = re.compile(r"^(?:@[A-Za-z0-9._-]+/)?[A-Za-z0-9._-]+$")
_NPM_PIN = re.compile(r"^(?:v|=)?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$")
_REQUIREMENTS = re.compile(r"requirements(?:[-_.][A-Za-z0-9._-]+)?\.(?:txt|lock|in)$")
_INFRA_NAMES = {"docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml", ".gitlab-ci.yml", "Jenkinsfile", "azure-pipelines.yml", "bitbucket-pipelines.yml"}
_RUNTIME_NAMES = {".python-version", ".node-version", ".nvmrc", ".tool-versions", ".npmrc", "pnpm-workspace.yaml", "pnpm-workspace.yml", ".pnpmfile.cjs", "pnpmfile.cjs", ".yarnrc", ".yarnrc.yml", "mise.toml", ".mise.toml"}
_IGNORED_DIRS = {".git", "node_modules", ".venv", "venv", "__pycache__"}
_GUARD = SecretGuard()


def _invalid() -> DomainError:
    return DomainError("INVALID_MANIFEST", "Could not parse a project manifest", 422)


def _path(value: object) -> str:
    if not isinstance(value, str) or not value or "\x00" in value:
        raise _invalid()
    value = value.replace("\\", "/")
    path = PurePosixPath(value)
    if not path.parts or path.is_absolute() or ".." in path.parts or any(":" in part for part in path.parts):
        raise _invalid()
    return path.as_posix()


def _kind(path: str) -> str | None:
    parts = PurePosixPath(path).parts
    if any(part in _IGNORED_DIRS for part in parts):
        return None
    name = parts[-1]
    if name == "package.json":
        return "npm"
    if name == "pyproject.toml":
        return "python"
    if _REQUIREMENTS.fullmatch(name) or ("requirements" in parts[:-1] and name.endswith((".txt", ".in", ".lock"))):
        return "requirements"
    if name in _RUNTIME_NAMES:
        return "runtime"
    if name == "Dockerfile" or name.startswith("Dockerfile.") or name.endswith(".Dockerfile") or name in _INFRA_NAMES:
        return "infra"
    if path.startswith((".github/workflows/", ".github/actions/", ".github/scripts/", ".circleci/", ".buildkite/")) and not name.lower().endswith((".md", ".rst", ".txt")):
        return "infra"
    if "infra" in parts[:-1] and not name.lower().endswith((".md", ".rst", ".txt")):
        return "infra"
    return None


def select_manifests(snapshot: dict) -> dict[str, str]:
    """Select UTF-8 manifest/infra bytes from a snapshot without reading the host."""
    result = {}
    files = snapshot.get("files")
    if not isinstance(files, list):
        raise _invalid()
    for entry in files:
        if not isinstance(entry, dict):
            raise _invalid()
        path = _path(entry.get("path"))
        if not _kind(path):
            continue
        if path in result or not isinstance(entry.get("content"), str):
            raise _invalid()
        content = entry["content"]
        if len(content) > 7_000_000:
            raise _invalid()
        try:
            encoding = entry.get("encoding", "utf-8")
            if encoding == "base64":
                content = base64.b64decode(content, validate=True).decode("utf-8-sig")
            elif encoding in {"utf-8", "utf8"}:
                content = content.removeprefix("\ufeff")
            else:
                raise _invalid()
        except (ValueError, UnicodeError):
            raise _invalid() from None
        result[path] = content
    return result


@dataclass(frozen=True)
class Dependency:
    name: str
    spec: str
    pin: tuple[int, int, bool] | None
    source: str = ""


Manifest = tuple[dict[str, Dependency], dict[str, Any]]


def _label(value: str) -> str:
    return _GUARD.redact(value)


def _python_requirement(text: str) -> tuple[str, Dependency]:
    try:
        requirement = Requirement(text)
    except (InvalidRequirement, TypeError):
        raise _invalid() from None
    name = str(canonicalize_name(requirement.name))
    marker = str(requirement.marker or "")
    extras = ",".join(sorted(requirement.extras))
    key = f"{name}[{extras}];{marker}"
    spec = str(requirement.specifier)
    pin = None
    parts = list(requirement.specifier)
    if len(parts) == 1 and parts[0].operator in {"==", "==="} and "*" not in parts[0].version:
        try:
            version = Version(parts[0].version)
            pin = (version.epoch, version.release[0], version.is_prerelease or version.is_devrelease)
        except InvalidVersion:
            pass
    # Source strings are compared but are never included in a proposal.
    return key, Dependency(name, spec, pin, requirement.url or "")


def _requirements(lines: list[str], namespace: str, deps: dict[str, Dependency]):
    for line in lines:
        if not isinstance(line, str):
            raise _invalid()
        key, dependency = _python_requirement(line)
        full_key = f"{namespace}:{key}"
        prior = deps.get(full_key)
        if prior and prior != dependency:
            # Multiple compatible constraints are valid PEP 508; their combined
            # expression is intentionally not treated as one exact version pin.
            sources = "|".join(sorted({value for value in (prior.source, dependency.source) if value}))
            dependency = Dependency(dependency.name, ",".join(sorted({prior.spec, dependency.spec})), None, sources)
        deps[full_key] = dependency


def _unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise _invalid()
        result[key] = value
    return result


def _invalid_constant(value):
    raise _invalid()


def _parse_npm(content: str) -> Manifest:
    try:
        manifest = json.loads(content, object_pairs_hook=_unique_object, parse_constant=_invalid_constant)
    except (ValueError, TypeError):
        raise _invalid() from None
    if not isinstance(manifest, dict):
        raise _invalid()
    deps: dict[str, Dependency] = {}
    for section in ("dependencies", "devDependencies", "peerDependencies", "optionalDependencies"):
        values = manifest.get(section, {})
        if not isinstance(values, dict):
            raise _invalid()
        for name, spec in values.items():
            if not _NPM_NAME.fullmatch(name) or not isinstance(spec, str) or not spec.strip():
                raise _invalid()
            spec = spec.strip()
            match = _NPM_PIN.fullmatch(spec)
            pin = (0, int(match[1]), bool(match[4])) if match else None
            deps[f"{section}:{name}"] = Dependency(name, spec, pin)
    controls = {key: manifest.get(key) for key in ("type", "engines", "devEngines", "os", "cpu", "packageManager", "scripts", "workspaces", "overrides", "resolutions", "pnpm")}
    return deps, controls


def _parse_python(content: str) -> Manifest:
    try:
        manifest = tomllib.loads(content)
        project = manifest.get("project", {})
        build = manifest.get("build-system", {})
        tool = manifest.get("tool", {})
        if not all(isinstance(value, dict) for value in (project, build, tool)):
            raise _invalid()
        deps: dict[str, Dependency] = {}
        direct = project.get("dependencies", [])
        optional = project.get("optional-dependencies", {})
        groups = manifest.get("dependency-groups", {})
        if not isinstance(direct, list) or not isinstance(optional, dict) or not isinstance(groups, dict):
            raise _invalid()
        _requirements(direct, "project", deps)
        controls: dict[str, Any] = {}
        dynamic = project.get("dynamic", [])
        if not isinstance(dynamic, list) or any(not isinstance(item, str) for item in dynamic):
            raise _invalid()
        controls["dynamic-dependencies"] = sorted(set(dynamic) & {"dependencies", "optional-dependencies", "requires-python"})
        for section, values in (("optional", optional), ("group", groups)):
            for name, entries in values.items():
                if not isinstance(entries, list):
                    raise _invalid()
                requirements = [entry for entry in entries if isinstance(entry, str)]
                _requirements(requirements, f"{section}:{name}", deps)
                references = [entry for entry in entries if not isinstance(entry, str)]
                if references:
                    if section != "group" or any(not isinstance(entry, dict) or set(entry) != {"include-group"} or not isinstance(entry["include-group"], str) for entry in references):
                        raise _invalid()
                    controls[f"dependency-group:{name}"] = sorted(entry["include-group"] for entry in references)
        runtime = project.get("requires-python")
        if runtime is not None:
            controls["requires-python"] = str(SpecifierSet(runtime))
        if "requires" in build:
            if not isinstance(build["requires"], list):
                raise _invalid()
            build_deps: dict[str, Dependency] = {}
            _requirements(build["requires"], "build", build_deps)
            build = build | {"requires": sorted((key, value.spec, value.source) for key, value in build_deps.items())}
        controls["build-system"] = build
        for name in ("uv", "poetry", "pytest", "coverage", "pdm"):
            if name in tool:
                if not isinstance(tool[name], dict):
                    raise _invalid()
                if name == "poetry":
                    # Legacy Poetry constraints are not PEP 508. Preserve a
                    # conservative owner gate rather than pretending to parse them.
                    controls[name] = {key: tool[name].get(key) for key in ("dependencies", "dev-dependencies", "group", "source", "requires-poetry")}
                else:
                    controls[name] = tool[name]
        return deps, controls
    except (tomllib.TOMLDecodeError, InvalidSpecifier, TypeError, ValueError):
        raise _invalid() from None


def _parse_requirements(content: str) -> Manifest:
    deps: dict[str, Dependency] = {}
    controls: dict[str, Any] = {}
    logical = content.replace("\\\r\n", " ").replace("\\\n", " ")
    options = []
    for raw in logical.splitlines():
        line = re.sub(r"\s+#.*$", "", raw).strip()
        if not line or line.startswith("#"):
            continue
        line = re.sub(r"\s+--hash(?:=|\s+)\S+", "", line).strip()
        if line.startswith(("-", "https://", "http://", "git+", "ssh://", "file:", "git@", "./", "../", "/")):
            options.append(" ".join(line.split()))
        else:
            _requirements([line], "requirements", deps)
    if options:
        controls["source-options"] = options
    return deps, controls


def material_changes(before: dict[str, str], after: dict[str, str]) -> list[str]:
    """Describe material changes without echoing source, credentials or source URLs."""
    changes = []
    selected: dict[str, dict[str, str]] = {}
    for label, files in (("before", before), ("after", after)):
        if not isinstance(files, dict):
            raise _invalid()
        selected[label] = {}
        for raw_path, content in files.items():
            path = _path(raw_path)
            if _kind(path):
                if not isinstance(content, str) or path in selected[label]:
                    raise _invalid()
                selected[label][path] = content.removeprefix("\ufeff")
    before, after = selected["before"], selected["after"]
    parsers: dict[str, Callable[[str], Manifest]] = {"npm": _parse_npm, "python": _parse_python, "requirements": _parse_requirements}
    for path in sorted(before.keys() | after.keys()):
        kind = _kind(path)
        parser = parsers.get(kind or "")
        old = parser(before[path]) if parser and path in before else None
        new = parser(after[path]) if parser and path in after else None
        if path not in before or path not in after:
            verb = "added" if path in after else "removed"
            changes.append(f"Completed: {verb} a {'infrastructure/CI' if kind == 'infra' else 'project configuration'} file: {_label(path)}.")
            continue
        if kind == "infra":
            if before[path].replace("\r\n", "\n") != after[path].replace("\r\n", "\n"):
                changes.append(f"Infrastructure or CI changed in {_label(path)}.")
            continue
        if kind == "runtime":
            if before[path].replace("\r\n", "\n") != after[path].replace("\r\n", "\n"):
                changes.append(f"Language, runtime or package manager configuration changed in {_label(path)}.")
            continue
        if old is None or new is None:
            raise _invalid()
        old_deps, old_controls = old
        new_deps, new_controls = new
        if old_controls != new_controls:
            changes.append(f"Runtime, package manager, build or controls changed in {_label(path)}.")
        for key in sorted(old_deps.keys() | new_deps.keys()):
            previous, current = old_deps.get(key), new_deps.get(key)
            if previous == current:
                continue
            if previous is None or current is None:
                dependency = current or previous
                if dependency is None:
                    raise _invalid()
                verb = "added to" if current else "removed from"
                changes.append(f"The dependency {_label(dependency.name)} was {verb} {_label(path)}.")
            elif previous.source or current.source:
                changes.append(f"The dependency source changed for {_label(current.name)} in {_label(path)}.")
            elif previous.pin and current.pin and previous.pin[:2] == current.pin[:2] and not previous.pin[2] and not current.pin[2]:
                continue
            else:
                changes.append(f"The major version or constraint changed for {_label(current.name)} in {_label(path)}.")
    return changes
