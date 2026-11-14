import json

from sabre.memory_sources import (
    MAX_SECTION_CHARS,
    MAX_STATEMENTS,
    MAX_STATEMENTS_PER_FILE,
    instruction_paths,
    instruction_statements,
    manifest_paths,
    repository_statements,
    title_of,
)

GUIDE = """# Pricing service

Prices are computed in cents.

## Verify

Run the checks before a pull request:

```sh
# unit tests, not a heading
pytest -q
```

### Slow suite

`pytest -m slow` takes ten minutes.

## Rules

## Notes

Keep commits small.

## Notes

Never edit generated files.
"""


def test_an_instruction_file_is_quoted_by_its_first_two_heading_levels_with_the_line_of_each():
    statements = instruction_statements("AGENTS.md", GUIDE)
    assert [(item.title, item.line) for item in statements] == [
        ("AGENTS.md › Pricing service", 1), ("AGENTS.md › Verify", 5), ("AGENTS.md › Notes", 20), ("AGENTS.md › Notes (2)", 24)]
    verify = statements[1]
    # A deeper heading stays inside its section and a fenced "#" is not a heading; the text is the file's own.
    assert verify.body == GUIDE.split("## Verify\n\n")[1].split("\n\n## Rules")[0]
    assert "### Slow suite" in verify.body and "# unit tests, not a heading" in verify.body
    assert verify.citation == "AGENTS.md#L5" and verify.source == "instructions"
    assert verify.content == "AGENTS.md › Verify\n" + verify.body and title_of(verify.content) == "AGENTS.md › Verify"
    # A heading with nothing under it says nothing.
    assert not any(item.title.endswith("Rules") for item in statements)


def test_text_before_the_first_heading_is_a_statement_named_after_the_file():
    statements = instruction_statements("docs/CONTRIBUTING.md", "\nOpen an issue first.\n\n## Style\nUse tabs.\n")
    assert [(item.title, item.line, item.body) for item in statements] == [
        ("docs/CONTRIBUTING.md", 2, "Open an issue first."), ("docs/CONTRIBUTING.md › Style", 4, "Use tabs.")]


def test_a_long_section_is_cut_at_blank_lines_into_parts_that_keep_every_line():
    paragraphs = [f"Paragraph {number} " + "word " * 150 for number in range(12)]
    content = "## Long\n\n" + "\n\n".join(paragraphs) + "\n"
    statements = instruction_statements("CLAUDE.md", content)
    assert len(statements) > 1 and all(len(item.body) <= MAX_SECTION_CHARS for item in statements)
    assert [item.title for item in statements[:2]] == ["CLAUDE.md › Long", "CLAUDE.md › Long · part 2"]
    assert "\n\n".join(item.body for item in statements) == "\n\n".join(paragraphs)
    lines = content.splitlines()
    assert statements[0].line == 1 and all(lines[item.line - 1] == item.body.split("\n")[0] for item in statements[1:])
    # A single line longer than the bound is split rather than dropped.
    unbroken = instruction_statements("CLAUDE.md", "x" * (MAX_SECTION_CHARS * 2 + 10))
    assert [len(item.body) for item in unbroken] == [MAX_SECTION_CHARS, MAX_SECTION_CHARS, 10]


def test_agent_files_count_anywhere_and_contribution_guides_only_where_a_project_keeps_its_own():
    paths = ["packages/api/AGENTS.md", "CLAUDE.md", "vendor/lib/CONTRIBUTING.md", ".github/CONTRIBUTING.md", "CONTRIBUTING.md",
             ".github/copilot-instructions.md", "README.md", "docs/agents.md.txt", "agents.md"]
    assert instruction_paths(paths) == ["CLAUDE.md", "CONTRIBUTING.md", "agents.md", ".github/CONTRIBUTING.md",
                                        ".github/copilot-instructions.md", "packages/api/AGENTS.md"]
    assert manifest_paths(["web/package.json", "package.json", "Makefile", "src/package.json.bak", "go.mod"]) == [
        "Makefile", "go.mod", "package.json", "web/package.json"]


def test_a_package_manifest_states_its_scripts_and_stack_without_versions():
    content = json.dumps({"name": "console", "packageManager": "pnpm@9.15.0", "type": "module", "engines": {"node": ">=22"},
                          "scripts": {"test": "vitest run", "build": "tsc -b && vite build"},
                          "dependencies": {"react": "19.0.0"}, "devDependencies": {"vitest": "3.0.0", "typescript": "5.7.2"}}, indent=2)
    statements, omitted = repository_statements({"web/package.json": content})
    assert omitted == 0 and [item.title for item in statements] == ["web/package.json › scripts", "web/package.json › stack"]
    scripts, stack = statements
    assert "- test: vitest run" in scripts.body and "- build: tsc -b && vite build" in scripts.body
    assert content.splitlines()[scripts.line - 1].strip().startswith('"scripts"') and scripts.source == "manifest"
    assert "Package manager: pnpm@9.15.0" in stack.body and "Engines: node >=22" in stack.body
    assert "Dependencies (1): react" in stack.body and "Development dependencies (2): typescript, vitest" in stack.body
    assert "19.0.0" not in stack.body and "5.7.2" not in stack.body


def test_other_manifests_state_what_they_declare():
    pyproject = """[build-system]
build-backend = "hatchling.build"

[project]
name = "pricing"
requires-python = ">=3.13"
dependencies = ["fastapi[standard]>=0.115", "psycopg ; python_version > '3.8'"]

[project.optional-dependencies]
dev = ["pytest"]

[project.scripts]
pricing = "pricing.cli:main"

[tool.ruff]
line-length = 120
"""
    cargo = '[package]\nname = "engine"\nedition = "2021"\n\n[dependencies]\nserde = "1"\n'
    go = "module example.com/pricing\n\ngo 1.23\n\nrequire (\n\tgithub.com/acme/money v1.2.0\n\tgithub.com/acme/log v0.3.0 // indirect\n)\n"
    make = "CC := gcc\n\n.PHONY: test\ntest: build\n\tpytest\n\nbuild:\n\tpython -m build\n"
    statements, _ = repository_statements({"pyproject.toml": pyproject, "Cargo.toml": cargo, "go.mod": go, "Makefile": make})
    by_title = {item.title: item for item in statements}
    project = by_title["pyproject.toml › project"]
    assert "Python: >=3.13" in project.body and "Build backend: hatchling.build" in project.body
    assert "Dependencies (2): fastapi, psycopg" in project.body and "Optional dependency groups: dev" in project.body
    assert "Entry points: pricing = pricing.cli:main" in project.body and "Configured tools: ruff" in project.body and project.line == 1
    assert "Crate: engine" in by_title["Cargo.toml › package"].body and "Dependencies (1): serde" in by_title["Cargo.toml › package"].body
    module = by_title["go.mod › module"]
    assert "Module: example.com/pricing" in module.body and "Go: 1.23" in module.body
    assert "Direct requirements (1): github.com/acme/money" in module.body
    targets = by_title["Makefile › targets"]
    assert targets.body.endswith("test, build") and targets.line == 4


def test_a_manifest_that_does_not_parse_or_declares_nothing_states_nothing():
    statements, omitted = repository_statements({"package.json": "{not json", "pyproject.toml": "[project", "web/package.json": "[]",
                                                 "Cargo.toml": "", "go.mod": "// empty", "Makefile": "CC := gcc\n"})
    assert statements == [] and omitted == 0


def test_one_read_is_bounded_and_reports_what_it_left_out():
    crowded = "\n".join(f"## Section {number}\n\ntext {number}\n" for number in range(MAX_STATEMENTS_PER_FILE + 3))
    statements, omitted = repository_statements({"AGENTS.md": crowded})
    assert len(statements) == MAX_STATEMENTS_PER_FILE and omitted == 3
    many = {f"pkg{number:02}/AGENTS.md": "## One\n\na\n\n## Two\n\nb\n\n## Three\n\nc\n\n## Four\n\nd\n" for number in range(12)}
    statements, omitted = repository_statements(many)
    assert len(statements) == MAX_STATEMENTS and omitted == 12 * 4 - MAX_STATEMENTS
    # Root files come first, so the bound never drops the project's own instructions for a nested package's.
    statements, _ = repository_statements({**many, "AGENTS.md": "## Root\n\nfirst\n"})
    assert statements[0].title == "AGENTS.md › Root"
