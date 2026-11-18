"""Reviewed instructions with explicit scope. Skills never grant capabilities.

Each skill is a Markdown file in this package: a front matter block naming the roles that
may use it, then the instruction. The instruction's digest is pinned in published agent
definitions and in every resolved flow, so editing a file is a reviewed change: runs and
definitions that pinned the earlier text are refused until they are published again.
"""

import hashlib
import re
from dataclasses import dataclass
from pathlib import Path

ROLES = frozenset({"analyst", "architect", "supervisor", "developer", "qa", "reviewer", "security", "designer", "devops"})
MAX_INSTRUCTION = 4000


@dataclass(frozen=True)
class Skill:
    roles: frozenset[str]
    instruction: str

    @property
    def digest(self) -> str:
        return hashlib.sha256(self.instruction.encode()).hexdigest()


def parse_skill(name: str, text: str) -> Skill:
    """Read one skill file. Line breaks in the body are layout: the instruction is one paragraph."""
    lines = text.replace("\r\n", "\n").split("\n")
    if not re.fullmatch(r"[a-z][a-z0-9_]{0,39}", name) or lines[0] != "---" or "---" not in lines[1:]:
        raise ValueError(f"Skill {name}: expected a front matter block between '---' lines")
    end = lines.index("---", 1)
    fields = dict(line.split(":", 1) for line in lines[1:end] if line.strip())
    if set(fields) != {"roles"}:
        raise ValueError(f"Skill {name}: the front matter declares exactly 'roles'")
    roles = frozenset(role.strip() for role in fields["roles"].split(","))
    if not roles or not roles <= ROLES:
        raise ValueError(f"Skill {name}: roles must be among {', '.join(sorted(ROLES))}")
    instruction = " ".join("\n".join(lines[end + 1:]).split())
    if not instruction or len(instruction) > MAX_INSTRUCTION:
        raise ValueError(f"Skill {name}: the instruction must have 1 to {MAX_INSTRUCTION} characters")
    return Skill(roles, instruction)


def load_skills(directory: Path) -> dict[str, Skill]:
    return {path.stem: parse_skill(path.stem, path.read_text(encoding="utf-8")) for path in sorted(directory.glob("*.md"))}


SKILLS = load_skills(Path(__file__).parent)

DEFAULT_SKILLS = {"analysis": ["engineering"], "design": ["engineering"], "planning": ["engineering"],
                  "implementation": ["engineering", "verification"], "verification": ["verification"],
                  "review": ["review"], "security": ["security"]}
