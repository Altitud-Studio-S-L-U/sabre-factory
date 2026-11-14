"""What a repository already says about itself, read without a model call.

Instruction files are quoted section by section; manifests are reduced to the commands and the stack
they declare. Every statement cites the file and line it came from, and its first line is a stable
title, so a later read can tell an unchanged statement from a changed one. Nothing here is trusted:
each statement becomes a proposal the owner approves or rejects.
"""

import json
import re
import tomllib
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import PurePosixPath
from typing import Any, Literal

# Agent instruction files count wherever they are; a contribution guide only where projects keep their own.
INSTRUCTION_NAMES = frozenset({"agents.md", "claude.md"})
INSTRUCTION_PATHS = frozenset({"contributing.md", ".github/contributing.md", "docs/contributing.md",
                               ".github/copilot-instructions.md"})
MAX_FILES = 12
MAX_STATEMENTS_PER_FILE = 12
MAX_STATEMENTS = 40
MAX_SECTION_CHARS = 4000
MAX_SOURCE_CHARS = 262_144
MAX_LISTED = 40
MAX_VALUE_CHARS = 200
MAX_HEADING_CHARS = 120

HEADING = re.compile(r"^(#{1,6})[ \t]+(.*?)[ \t]*#*[ \t]*$")
FENCE = re.compile(r"^[ \t]{0,3}(`{3,}|~{3,})")
DECLARED = "Declared by this manifest; dependency versions are left out because they change often.\n"
MAKE_TARGET = re.compile(r"^([A-Za-z0-9][A-Za-z0-9_./-]*)[ \t]*:(?![=:])")
REQUIREMENT_NAME = re.compile(r"[\s\[<>=!~;(@]")


@dataclass(frozen=True)
class Statement:
    title: str
    body: str
    path: str
    line: int
    source: Literal["instructions", "manifest"]

    @property
    def content(self) -> str:
        return f"{self.title}\n{self.body}"

    @property
    def citation(self) -> str:
        return f"{self.path}#L{self.line}"


def title_of(content: str) -> str:
    """The stable title of a recorded statement: its first line."""
    return content.split("\n", 1)[0]


def clip(value: str, size: int = MAX_VALUE_CHARS) -> str:
    text = " ".join(value.split())
    return text if len(text) <= size else text[:size - 1].rstrip() + "…"


def listed(values: list[str], noun: str) -> str:
    shown = ", ".join(clip(value, 80) for value in values[:MAX_LISTED])
    more = len(values) - MAX_LISTED
    return shown + (f" and {more} more {noun}" if more > 0 else "")


def by_depth(paths: list[str]) -> list[str]:
    return sorted(paths, key=lambda path: (path.count("/"), path))[:MAX_FILES]


def instruction_paths(paths) -> list[str]:
    return by_depth([path for path in paths
                     if PurePosixPath(path).name.casefold() in INSTRUCTION_NAMES or path.casefold() in INSTRUCTION_PATHS])


def markdown_sections(content: str) -> list[tuple[str | None, int, list[str]]]:
    """The preamble and every heading of the first two levels as (heading, line, body lines).

    Deeper headings stay inside their section, and a ``#`` inside a fenced block is not a heading.
    """
    sections: list[tuple[str | None, int, list[str]]] = []
    heading: str | None = None
    fence: str | None = None
    start, body = 1, list[str]()
    for number, line in enumerate(content.splitlines(), 1):
        marker = FENCE.match(line)
        if marker:
            fence = marker.group(1)[0] if fence is None else None if fence == marker.group(1)[0] else fence
        match = HEADING.match(line) if fence is None and not marker else None
        if match and len(match.group(1)) <= 2:
            sections.append((heading, start, body))
            heading, start, body = clip(match.group(2), MAX_HEADING_CHARS) or "Untitled", number, []
        else:
            body.append(line)
    sections.append((heading, start, body))
    return sections


def parts(lines: list[str], first_line: int, limit: int) -> list[tuple[int, str]]:
    """Cut a section so no part exceeds ``limit`` characters, at a blank line when there is one."""
    numbered = [(first_line + offset, text) for offset, line in enumerate(lines)
                for text in ([line[index:index + limit] for index in range(0, len(line), limit)] or [""])]
    result: list[tuple[int, str]] = []
    chunk: list[tuple[int, str]] = []

    def emit(entries):
        while entries and not entries[0][1].strip():
            entries = entries[1:]
        while entries and not entries[-1][1].strip():
            entries = entries[:-1]
        if entries:
            result.append((entries[0][0], "\n".join(text for _, text in entries)))

    size = 0
    for entry in numbered:
        while chunk and size + len(entry[1]) + 1 > limit:
            blank = next((index for index in range(len(chunk) - 1, 0, -1) if not chunk[index][1].strip()), None)
            emit(chunk if blank is None else chunk[:blank])
            chunk = [] if blank is None else chunk[blank + 1:]
            size = sum(len(text) + 1 for _, text in chunk)
        chunk.append(entry)
        size += len(entry[1]) + 1
    emit(chunk)
    return result


def instruction_statements(path: str, content: str) -> list[Statement]:
    statements = []
    counts: dict[str, int] = {}
    for heading, line, body in markdown_sections(content):
        base = path if heading is None else f"{path} › {heading}"
        counts[base] = counts.get(base, 0) + 1
        if counts[base] > 1:
            base = f"{base} ({counts[base]})"
        # The heading is the first cited line; a preamble is cited where its text starts.
        offset = line if heading is None else line + 1
        for index, (start, text) in enumerate(parts(body, offset, MAX_SECTION_CHARS)):
            statements.append(Statement(base if index == 0 else f"{base} · part {index + 1}", text, path,
                                        line if heading is not None and index == 0 else start, "instructions"))
    return statements


def key_line(content: str, pattern: str) -> int:
    expression = re.compile(pattern)
    return next((number for number, line in enumerate(content.splitlines(), 1) if expression.match(line)), 1)


def table(value: Any) -> dict[Any, Any]:
    """A manifest table, or an empty one when the manifest holds something else there."""
    return value if isinstance(value, dict) else {}


def names(value: Any) -> list[str]:
    return sorted(key for key in table(value) if isinstance(key, str))


def package_statements(path: str, content: str) -> list[Statement]:
    data = json.loads(content)
    if not isinstance(data, dict):
        return []
    statements = []
    scripts = [(name, command) for name, command in table(data.get("scripts")).items() if isinstance(name, str) and isinstance(command, str)]
    if scripts:
        lines = [f"- {clip(name, 80)}: {clip(command)}" for name, command in scripts[:MAX_LISTED]]
        if len(scripts) > MAX_LISTED:
            lines.append(f"- and {len(scripts) - MAX_LISTED} more scripts")
        statements.append(Statement(f"{path} › scripts", "Scripts this manifest declares; none was run to confirm it.\n" + "\n".join(lines),
                                    path, key_line(content, r'^\s*"scripts"\s*:'), "manifest"))
    facts = [f"{label}: {clip(data[key])}" for label, key in (("Package", "name"), ("Package manager", "packageManager"), ("Module type", "type"))
             if isinstance(data.get(key), str) and data[key].strip()]
    engines = data.get("engines")
    if isinstance(engines, dict) and engines:
        facts.append("Engines: " + ", ".join(f"{clip(str(name), 40)} {clip(str(value), 40)}" for name, value in list(engines.items())[:8]))
    workspaces = data.get("workspaces")
    workspaces = workspaces.get("packages") if isinstance(workspaces, dict) else workspaces
    if isinstance(workspaces, list) and workspaces:
        facts.append("Workspaces: " + listed([str(item) for item in workspaces], "workspaces"))
    for label, key in (("Dependencies", "dependencies"), ("Development dependencies", "devDependencies")):
        found = names(data.get(key))
        if found:
            facts.append(f"{label} ({len(found)}): {listed(found, 'packages')}")
    if facts:
        statements.append(Statement(f"{path} › stack", DECLARED + "\n".join(facts),
                                    path, key_line(content, r'^\s*"(dependencies|devDependencies|name)"\s*:'), "manifest"))
    return statements


def requirement(value: str) -> str:
    return REQUIREMENT_NAME.split(value.strip(), maxsplit=1)[0]


def pyproject_statements(path: str, content: str) -> list[Statement]:
    data = tomllib.loads(content)
    project = table(data.get("project"))
    facts = [f"{label}: {clip(project[key])}" for label, key in (("Package", "name"), ("Python", "requires-python"))
             if isinstance(project.get(key), str) and project[key].strip()]
    backend = table(data.get("build-system")).get("build-backend")
    if isinstance(backend, str):
        facts.append(f"Build backend: {clip(backend)}")
    required = project.get("dependencies")
    dependencies = sorted({requirement(item) for item in (required if isinstance(required, list) else []) if isinstance(item, str) and requirement(item)})
    if dependencies:
        facts.append(f"Dependencies ({len(dependencies)}): {listed(dependencies, 'packages')}")
    groups = names(project.get("optional-dependencies"))
    if groups:
        facts.append("Optional dependency groups: " + listed(groups, "groups"))
    entry_points = [f"{name} = {target}" for name, target in table(project.get("scripts")).items() if isinstance(target, str)]
    if entry_points:
        facts.append("Entry points: " + listed(entry_points, "entry points"))
    tools = names(data.get("tool"))
    if tools:
        facts.append("Configured tools: " + listed(tools, "tools"))
    if not facts:
        return []
    return [Statement(f"{path} › project", DECLARED + "\n".join(facts),
                      path, key_line(content, r"^\s*\[(project|tool\.|build-system)"), "manifest")]


def cargo_statements(path: str, content: str) -> list[Statement]:
    data = tomllib.loads(content)
    package = table(data.get("package"))
    facts = [f"{label}: {clip(package[key])}" for label, key in (("Crate", "name"), ("Edition", "edition"), ("Rust", "rust-version"))
             if isinstance(package.get(key), str) and package[key].strip()]
    members = table(data.get("workspace")).get("members")
    if isinstance(members, list) and members:
        facts.append("Workspace members: " + listed([str(item) for item in members], "members"))
    for label, key in (("Dependencies", "dependencies"), ("Development dependencies", "dev-dependencies")):
        found = names(data.get(key))
        if found:
            facts.append(f"{label} ({len(found)}): {listed(found, 'crates')}")
    if not facts:
        return []
    return [Statement(f"{path} › package", DECLARED + "\n".join(facts),
                      path, key_line(content, r"^\s*\[(package|workspace)\]"), "manifest")]


def go_statements(path: str, content: str) -> list[Statement]:
    module = re.search(r"^module[ \t]+(\S+)", content, re.MULTILINE)
    if module is None:
        return []
    facts = [f"Module: {clip(module.group(1))}"]
    version = re.search(r"^go[ \t]+(\S+)", content, re.MULTILINE)
    if version:
        facts.append(f"Go: {clip(version.group(1), 40)}")
    # Indirect requirements carry a trailing comment and are left out.
    required = sorted({match.group(1) for match in re.finditer(r"^(?:require[ \t]+|[ \t]+)(\S+)[ \t]+v\S+[ \t]*$", content, re.MULTILINE)})
    if required:
        facts.append(f"Direct requirements ({len(required)}): {listed(required, 'modules')}")
    return [Statement(f"{path} › module", DECLARED + "\n".join(facts),
                      path, key_line(content, r"^module[ \t]"), "manifest")]


def make_statements(path: str, content: str) -> list[Statement]:
    targets: list[str] = []
    first = 0
    for number, line in enumerate(content.splitlines(), 1):
        match = MAKE_TARGET.match(line)
        if match and match.group(1) not in targets:
            targets.append(match.group(1))
            first = first or number
    if not targets:
        return []
    return [Statement(f"{path} › targets", "Targets this Makefile declares; none was run to confirm it.\n" + listed(targets, "targets"),
                      path, first, "manifest")]


MANIFESTS: dict[str, Callable[[str, str], list[Statement]]] = {
    "package.json": package_statements, "pyproject.toml": pyproject_statements, "Cargo.toml": cargo_statements,
    "go.mod": go_statements, "Makefile": make_statements,
}


def manifest_paths(paths) -> list[str]:
    return by_depth([path for path in paths if PurePosixPath(path).name in MANIFESTS])


def repository_statements(files: dict[str, str]) -> tuple[list[Statement], int]:
    """Statements read from ``files`` (path to text) and how many were left out by the bounds.

    Only the first ``MAX_FILES`` instruction files and manifests, nearest the root, are read.
    """
    found: list[Statement] = []
    omitted = 0
    for path in instruction_paths(files):
        content = files[path]
        produced = instruction_statements(path, content) if len(content) <= MAX_SOURCE_CHARS else []
        found += produced[:MAX_STATEMENTS_PER_FILE]
        omitted += max(0, len(produced) - MAX_STATEMENTS_PER_FILE)
    for path in manifest_paths(files):
        content = files[path]
        try:
            produced = MANIFESTS[PurePosixPath(path).name](path, content) if len(content) <= MAX_SOURCE_CHARS else []
        except (ValueError, TypeError, AttributeError, RecursionError):
            produced = []  # An invalid manifest declares nothing the factory can quote.
        found += produced
    return found[:MAX_STATEMENTS], omitted + max(0, len(found) - MAX_STATEMENTS)
