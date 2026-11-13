"""Repair lessons: what failed during a run and what made verification pass, proposed for review.

Everything here is deterministic and free of model calls: a lesson is assembled from the repair
cycles the workflow recorded, so replaying consolidation proposes the same memory with the same id.
Lessons are never active on their own; the owner approves, edits (by proposing a replacement) or
rejects them in the review queue. Text that came from models is quoted and marked as observed.
"""

from typing import Any

from sabre.models import MemoryCreate, ProposedBy, SecurityFinding, WorkOrder
from sabre.security import is_blocking_finding

MAX_REPAIR_ENTRIES = 8
MAX_LISTED = 5
EXCERPT_CHARS = 240
FIX_CHARS = 600
OBJECTIVE_CHARS = 200


def excerpt(value: str | None, size: int) -> str:
    text = " ".join((value or "").split())
    return text if len(text) <= size else text[:size - 1].rstrip() + "…"


def repair_entry(state: dict, failures: list[str], security: dict, cycle: int) -> dict[str, Any]:
    """One repair cycle as the route decided it: the failed checks, blocking findings and rejections."""
    blocking = [finding for finding in security.get("findings", [])
                if is_blocking_finding(SecurityFinding.model_validate(finding))]
    # QA and review only judge when the deterministic checks passed; otherwise their text is boilerplate.
    judged = not failures
    return {
        "cycle": cycle,
        "failed_checks": failures[:MAX_LISTED],
        "omitted_checks": max(0, len(failures) - MAX_LISTED),
        "security": [f"{finding.get('category')}: {excerpt(finding.get('title'), 120)}" for finding in blocking[:MAX_LISTED]],
        "qa": excerpt(state.get("qa_review"), EXCERPT_CHARS) if judged and not state.get("qa_ok") else None,
        "review": excerpt(state.get("review"), EXCERPT_CHARS) if judged and not state.get("review_ok") else None,
    }


def append_repair(log: list[dict] | None, entry: dict) -> list[dict]:
    """Keep the first cycle (what broke) and the latest ones, bounded."""
    entries = [*(log or []), entry]
    if len(entries) <= MAX_REPAIR_ENTRIES:
        return entries
    return [entries[0], *entries[-(MAX_REPAIR_ENTRIES - 1):]]


def describe(entry: dict) -> str:
    parts = []
    if entry.get("failed_checks"):
        listed = ", ".join(f"`{command}`" for command in entry["failed_checks"])
        more = f" and {entry['omitted_checks']} more" if entry.get("omitted_checks") else ""
        parts.append(f"failed {listed}{more}")
    if entry.get("security"):
        parts.append("blocking security findings " + "; ".join(entry["security"]))
    if entry.get("qa"):
        parts.append(f'QA rejected: "{entry["qa"]}"')
    if entry.get("review"):
        parts.append(f'review rejected: "{entry["review"]}"')
    return "; ".join(parts) or "repair requested without a recorded reason"


def repair_lesson(work: WorkOrder, log: list[dict] | None) -> MemoryCreate | None:
    """The lesson for a delivered run that needed repairs, or None when it passed first time."""
    if not log or not work.evidence:
        return None
    fixer = next((task for task in reversed(work.tasks) if task.role == "developer" and task.result), None)
    cycles = work.repair_cycles_used or len(log)
    lines = [
        f"Repair lesson: {excerpt(work.objective, OBJECTIVE_CHARS)}",
        f"Verification passed after {cycles} repair cycle{'s' if cycles != 1 else ''}; delivered at commit {work.evidence.commit[:12]}.",
        *(f"- Cycle {entry['cycle']}: {describe(entry)}." for entry in log),
    ]
    if fixer is not None:
        lines.append(f'Change that passed (developer summary, observed): "{excerpt(fixer.result, FIX_CHARS)}"')
    return MemoryCreate(project_id=work.project_id, kind="lesson", content="\n".join(lines),
                        source_commit=work.evidence.commit, source_work_id=work.id,
                        evidence_digest=work.evidence.snapshot_digest, scope="project")


def lesson_proposer(work: WorkOrder) -> ProposedBy:
    return ProposedBy(channel="factory", role="repair", work_id=work.id)
