"""SABRE Bench: drive the real factory graph and agent loop over fixture repositories.

The scripted driver replaces only the language model with a reference policy that
inspects, edits and verifies the way a competent agent would. Stages, prompts, tool
policies, context projection, budgets and checkpoints are the production code. Results
therefore measure harness behaviour (calls, bytes, tool time, stage order, what each
role is told), not model quality. Token counts are estimates (UTF-8 bytes / 4) because
no provider is called. A real-provider run needs an explicit owner budget and is out of
scope for this driver.
"""

import argparse
import asyncio
import hashlib
import json
import math
import os
import shutil
import sys
import tempfile
import time
from collections import Counter
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal

from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import AIMessage, BaseMessage, HumanMessage, SystemMessage, ToolMessage
from langchain_core.outputs import ChatGeneration, ChatResult
from langgraph.checkpoint.memory import InMemorySaver
from pydantic import BaseModel, ConfigDict, Field, PrivateAttr

from sabre.agents import ROLE_PROMPTS, AgentTeam, input_reservation_tokens
from sabre.artifacts import ArtifactStore
from sabre.executor import ExecutionResult
from sabre.models import AgentResult, Budget, DomainError, Project, Status, Task, WorkOrder
from sabre.security import SecretGuard, SecurityReport, security_policy_digest

SUITE = Path(__file__).resolve().parents[2] / "bench"
ESTIMATE_BASIS = "estimated_utf8_bytes_div_4"


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Edit(StrictModel):
    path: str
    old: str
    new: str


class PlanReference(StrictModel):
    title: str
    scope: list[str]
    acceptance: list[str]


class Reference(StrictModel):
    inspect: list[str] = Field(default_factory=list)
    plan: PlanReference | None = None
    edits: list[Edit] = Field(default_factory=list)
    # A first developer attempt that fails its check. The policy notes the failure; only an
    # attempt that receives that note applies `edits` (written against the first attempt).
    first_attempt: list[Edit] = Field(default_factory=list)
    findings: str | None = None


class Grader(StrictModel):
    kind: Literal["tests", "audit"]
    files: dict[str, str] = Field(default_factory=dict)
    argv: list[str] = Field(default_factory=list)
    mentions: list[str] = Field(default_factory=list)


class BenchTask(StrictModel):
    id: str = Field(pattern=r"^[a-z0-9][a-z0-9-]{0,63}$")
    repo: str = Field(pattern=r"^[a-z0-9][a-z0-9-]{0,63}$")
    mode: Literal["patch", "audit", "maintain"]
    objective: str
    acceptance: list[str]
    gate_commands: list[list[str]]
    grader: Grader
    reference: Reference


def estimate_tokens(value: Any) -> int:
    return math.ceil(len(json.dumps(value, ensure_ascii=False, default=str).encode()) / 4)


def role_of(messages: list[BaseMessage]) -> str:
    system = " ".join(str(m.content) for m in messages if isinstance(m, SystemMessage))
    matches = [role for role, prompt in ROLE_PROMPTS.items() if prompt in system]
    if len(matches) != 1:
        raise DomainError("BENCH_ROLE_UNKNOWN", "The bench policy could not identify the agent role")
    return matches[0]


def opening_input(messages: list[BaseMessage]) -> dict:
    human = next((m for m in messages if isinstance(m, HumanMessage)), None)
    try:
        value = json.loads(str(human.content)) if human else {}
    except ValueError:
        return {}
    return value if isinstance(value, dict) else {}


def tool_payload(message: ToolMessage) -> Any:
    content = message.content
    if isinstance(content, str):
        try:
            return json.loads(content)
        except ValueError:
            return content
    return content


@dataclass
class Trace:
    """Order of observable harness actions and what each role was told."""

    entries: list[str] = field(default_factory=list)
    first_inputs: dict[str, dict] = field(default_factory=dict)
    # The opening input of every agent conversation, in order (repair attempts included).
    openings: list[tuple[str, dict]] = field(default_factory=list)
    summaries: dict[str, str] = field(default_factory=dict)
    calls: list[dict] = field(default_factory=list)


class ReferenceModel(BaseChatModel):
    """A deterministic reference policy. It never sees anything the production prompt omits."""

    task: BenchTask
    _trace: Trace = PrivateAttr(default_factory=Trace)

    @property
    def _llm_type(self) -> str:
        return "sabre-bench-reference"

    def bind_tools(self, tools, **kwargs):
        return self

    def _generate(self, messages, stop=None, run_manager=None, **kwargs):
        role = role_of(messages)
        trace = self._trace
        rounds = sum(isinstance(m, AIMessage) for m in messages)
        if rounds == 0:
            trace.entries.append(f"agent:{role}")
            opening = opening_input(messages)
            trace.first_inputs.setdefault(role, opening)
            trace.openings.append((role, opening))
        calls, result = self.step(role, rounds, messages)
        if result is not None:
            trace.summaries[role] = result.summary
            calls = [{"name": "AgentResult", "args": result.model_dump(mode="json"), "id": f"{role}-result", "type": "tool_call"}]
        message = AIMessage(content="", tool_calls=calls)
        inputs = estimate_tokens([m.model_dump(mode="json") for m in messages])
        outputs = estimate_tokens(calls)
        message.usage_metadata = {"input_tokens": inputs, "output_tokens": outputs, "total_tokens": inputs + outputs}
        trace.calls.append({"role": role, "round": rounds, "estimated_input_tokens": inputs, "estimated_output_tokens": outputs,
                            "tools": [call["name"] for call in calls]})
        return ChatResult(generations=[ChatGeneration(message=message)])

    def replies(self, messages) -> dict[str, Any]:
        return {m.tool_call_id: tool_payload(m) for m in messages if isinstance(m, ToolMessage)}

    def step(self, role: str, rounds: int, messages) -> tuple[list[dict], AgentResult | None]:
        reference, task = self.task.reference, self.task
        replies = self.replies(messages)

        def call(name, args, key):
            return {"name": name, "args": args, "id": f"{role}-{key}", "type": "tool_call"}

        if role == "analyst":
            if rounds == 0:
                return [call("list_files", {}, "list")] + [call("read_file", {"path": path}, f"read-{i}") for i, path in enumerate(reference.inspect)], None
            summary = reference.findings or f"Requirements inspected for: {task.objective}"
            return [], AgentResult(accepted=True, summary=summary)
        if role == "supervisor":
            plan = reference.plan or PlanReference(title=task.objective[:300], scope=[], acceptance=task.acceptance)
            return [], AgentResult(accepted=True, summary="Plan prepared", tasks=[Task(title=plan.title, scope=plan.scope,
                acceptance=plan.acceptance, verification_commands=task.gate_commands)])
        if role == "developer":
            # A repair attempt knows what failed only from its own earlier work notes.
            noted = (opening_input(messages).get("work_notes") or {}).get("notes") or []
            edits = reference.first_attempt if reference.first_attempt and not noted else reference.edits
            paths = list(dict.fromkeys(edit.path for edit in edits))
            if rounds == 0:
                return [call("read_file", {"path": path}, f"read-{i}") for i, path in enumerate(paths)], None
            if rounds == 1:
                writes = []
                for i, path in enumerate(paths):
                    content = replies.get(f"developer-read-{i}")
                    if not isinstance(content, str):
                        return [], AgentResult(accepted=False, summary=f"Could not read {path}")
                    for edit in (e for e in edits if e.path == path):
                        if content.count(edit.old) != 1:
                            return [], AgentResult(accepted=False, summary=f"Reference edit does not apply to {path}")
                        content = content.replace(edit.old, edit.new)
                    writes.append(call("write_file", {"path": path, "content": content}, f"write-{i}"))
                return writes, None
            if rounds == 2:
                return [call("execute", {"argv": task.gate_commands[0]}, "check")], None
            outcome = replies.get("developer-check")
            passed = isinstance(outcome, dict) and outcome.get("exit_code") == 0
            if not passed and rounds == 3:
                # Record the dead end before handing back, so the repair attempt need not rediscover it.
                return [call("record_note", {"note": f"Attempt failed: {' '.join(task.gate_commands[0])} fails after editing "
                             f"{', '.join(paths)} with the first approach. Revisit that edit instead of re-reading the repository."}, "note")], None
            return [], AgentResult(accepted=passed, summary="Implemented and checked" if passed else "The check still fails")
        if role == "qa":
            # Recorded gate evidence is enough when present; otherwise run the checks itself.
            evidence = (self._trace.first_inputs.get("qa", {}).get("task_context") or {}).get("evidence") or {}
            recorded = evidence.get("results") if evidence.get("kind") == "deterministic_gate_results" else None
            if recorded:
                passed = all(item.get("exit_code") == 0 for item in recorded)
                return [], AgentResult(accepted=passed, summary="Recorded gates pass" if passed else "Recorded gates fail")
            if rounds == 0:
                return [call("execute", {"argv": argv}, f"gate-{i}") for i, argv in enumerate(task.gate_commands)], None
            passed = all(isinstance(value, dict) and value.get("exit_code") == 0 for key, value in replies.items() if key.startswith("qa-gate-"))
            return [], AgentResult(accepted=passed, summary="Checks pass" if passed else "Checks fail")
        if role == "reviewer":
            paths = list(dict.fromkeys(edit.path for edit in reference.edits)) or reference.inspect[:1]
            if rounds == 0:
                return [call("read_file", {"path": path}, f"read-{i}") for i, path in enumerate(paths)], None
            return [], AgentResult(accepted=True, summary="Changes reviewed")
        return [], AgentResult(accepted=True, summary=f"{role} reviewed")


class LocalExecutor:
    """Workspace operations on a local copy. Commands come only from bench task files."""

    def __init__(self, source: Path, root: Path, trace: Trace):
        self.source, self.root, self.trace = source, root, trace
        self.base_commit = hashlib.sha1(json.dumps(self._files(source), sort_keys=True).encode(), usedforsecurity=False).hexdigest()
        self.final_snapshot: dict | None = None

    @staticmethod
    def _files(base: Path) -> list[dict]:
        files = []
        for path in sorted(base.rglob("*")):
            relative = path.relative_to(base).as_posix()
            if path.is_file() and "__pycache__" not in relative:
                files.append({"path": relative, "content": path.read_text(encoding="utf-8")})
        return files

    def workspace(self, work_id: str) -> Path:
        return self.root / work_id

    def _path(self, work_id: str, path: str) -> Path:
        base = self.workspace(work_id).resolve()
        target = (base / path).resolve()
        if not target.is_relative_to(base) or target == base:
            raise DomainError("INVALID_PATH", "The path is outside the workspace", 422)
        return target

    async def prepare(self, project, work_id: str) -> None:
        if not self.workspace(work_id).exists():
            shutil.copytree(self.source, self.workspace(work_id), ignore=shutil.ignore_patterns("__pycache__"))

    async def snapshot(self, work_id: str) -> dict:
        files = self._files(self.workspace(work_id))
        listing = [(f["path"], hashlib.sha256(f["content"].encode()).hexdigest()) for f in files]
        return {"digest": hashlib.sha256(json.dumps(listing).encode()).hexdigest(), "base_commit": self.base_commit, "files": files}

    async def current_digest(self, work_id: str) -> str:
        return (await self.snapshot(work_id))["digest"]

    async def list_files(self, work_id: str) -> list[str]:
        return [f["path"] for f in self._files(self.workspace(work_id))]

    async def read_file(self, work_id: str, path: str) -> str:
        return self._path(work_id, path).read_text(encoding="utf-8")

    async def write_file(self, work_id: str, path: str, content: str, *, expected_content_digest: str | None = None) -> None:
        target = self._path(work_id, path)
        if expected_content_digest is not None and target.exists() and hashlib.sha256(target.read_bytes()).hexdigest() != expected_content_digest:
            raise DomainError("STALE_CONTENT", "The file changed since it was read", 409)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding="utf-8")

    async def _run(self, cwd: Path, argv: list[str], timeout_s: int) -> ExecutionResult:
        environment = {"PATH": os.environ.get("PATH", ""), "PYTHONDONTWRITEBYTECODE": "1", "PYTHONHASHSEED": "0"}
        process = await asyncio.create_subprocess_exec(*argv, cwd=cwd, env=environment, stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT)
        try:
            output, _ = await asyncio.wait_for(process.communicate(), timeout_s)
        except TimeoutError:
            process.kill()
            await process.wait()
            return ExecutionResult(exit_code=124, output="Timed out")
        return ExecutionResult(exit_code=process.returncode if process.returncode is not None else 1, output=output.decode(errors="replace"))

    async def execute(self, work_id: str, argv: list[str], timeout_s=300) -> ExecutionResult:
        self.trace.entries.append("tool:execute")
        return await self._run(self.workspace(work_id), argv, timeout_s)

    async def execute_gate(self, work_id: str, argv: list[str], digest: str, timeout_s=300) -> ExecutionResult:
        if digest != await self.current_digest(work_id):
            raise DomainError("STALE_EVIDENCE", "The gate snapshot does not match the workspace")
        self.trace.entries.append("gate")
        with tempfile.TemporaryDirectory(prefix="sabre-bench-gate-") as copy:
            target = Path(copy) / "workspace"
            shutil.copytree(self.workspace(work_id), target)
            return await self._run(target, argv, timeout_s)

    async def prepare_dependencies(self, work_id: str) -> None:
        return None

    async def resolve_dependencies(self, work_id: str) -> dict:
        return {"resolved": False}

    async def security_version(self, work_id: str) -> str:
        return "bench-rules-1"

    async def cleanup(self, work_id: str) -> None:
        if self.workspace(work_id).exists():
            self.final_snapshot = await self.snapshot(work_id)


class BenchRepository:
    """In-memory run store with the production legacy budget rule (reserved or measured tokens)."""

    def __init__(self, work: WorkOrder, project: Project):
        self.current, self.project_value = work.model_copy(deep=True), project
        self.usage_rows: list[dict] = []
        self.execution_events: list = []

    async def work(self, work_id):
        return self.current.model_copy(deep=True)

    async def save(self, work):
        self.current = work.model_copy(deep=True)

    async def add_active_seconds(self, work_id, seconds):
        self.current.active_seconds_used += seconds

    async def project(self, project_id):
        return self.project_value

    async def control(self, work_id):
        return None

    async def event(self, work, kind, message):
        return None

    async def usage(self, work_id):
        tokens = sum(row["actual"] if row["actual"] is not None else row["reserved"] for row in self.usage_rows)
        return {"calls": len(self.usage_rows), "tokens": tokens, "usd": 0}

    async def pending_answer(self, work_id):
        return None

    async def pending_scope(self, work_id):
        return None

    async def clear_answer(self, work_id, question_id=None):
        return None

    async def report_security(self, work):
        return None

    async def security_exceptions(self, work_id):
        return []

    @asynccontextmanager
    async def project_lock(self, project_id, *, execution_slot=True):
        yield True

    async def reserve_usage(self, work, tokens, usd, monthly_limit, *, context_receipt=None):
        totals = await self.usage(work.id)
        budget = work.budget
        if budget.max_calls is not None and totals["calls"] >= budget.max_calls:
            raise DomainError("BUDGET_EXHAUSTED", "The pending model-call reservation does not fit the authorized budget")
        if budget.max_tokens is not None and totals["tokens"] + tokens > budget.max_tokens:
            raise DomainError("BUDGET_EXHAUSTED", "The pending model-call reservation does not fit the authorized budget")
        receipt = context_receipt.model_dump(mode="json") if context_receipt is not None else {}
        self.usage_rows.append({"reserved": tokens, "actual": None, "breakdown": None, "role": receipt.get("role"),
                                "sent_bytes": receipt.get("sent_bytes"), "original_bytes": receipt.get("original_bytes")})
        return str(len(self.usage_rows))

    async def settle_usage(self, usage_id, tokens, usd, *, breakdown=None):
        row = self.usage_rows[int(usage_id) - 1]
        row["actual"], row["breakdown"] = tokens, breakdown

    async def record_execution_event(self, event):
        self.execution_events.append(event)


class NoFindings:
    async def review(self, work_id, digest, baseline, exceptions=None, *, plan_revision=1):
        return SecurityReport(snapshot_digest=digest, rules_version="bench-rules-1", findings=[], blocked=False,
            policy_digest=security_policy_digest(work_id, digest, "bench-rules-1", baseline, exceptions or [], plan_revision=plan_revision))


class CapturingPublisher:
    def __init__(self, executor: LocalExecutor):
        self.executor = executor
        self.snapshot: dict | None = None

    async def prepare_commit(self, work, project, snapshot):
        self.snapshot = snapshot
        return "c" * 40

    async def publish(self, work, project, *, expected_base):
        return {"branch": f"sabre/{work.id}", "pr_url": "https://bench.invalid/pull/1"}

    async def validate_base(self, project, expected_commit):
        return None


class NoMemory:
    async def context_for_role(self, *args, **kwargs):
        return []

    def reader(self, *args):
        async def read_memory(**kwargs):
            return {}
        return read_memory

    def context_validator(self, *args):
        async def validate(references):
            return None
        return validate

    async def propose(self, item, **kwargs):
        return item


def bench_settings():
    from types import SimpleNamespace
    return SimpleNamespace(model_max_output_tokens=4096, model_input_usd_per_million=0, model_output_usd_per_million=0,
        monthly_budget_usd=0, mcp_servers={}, context_input_max_bytes=98304, context_dedup_enabled=True,
        context_dedup_trigger_bytes=65536, context_dedup_min_result_bytes=4096, context_dedup_keep_model_turns=2,
        context_archive_enabled=True, model_name="bench-reference")


async def grade(task: BenchTask, suite: Path, executor: LocalExecutor, work: WorkOrder, trace: Trace, final: dict | None) -> dict:
    if task.grader.kind == "audit":
        report = trace.summaries.get("analyst", "")
        missing = [term for term in task.grader.mentions if term.casefold() not in report.casefold()]
        original = executor._files(executor.source)
        unchanged = final is not None and [f["content"] for f in final["files"]] == [f["content"] for f in original]
        passed = work.status == Status.COMPLETED and not missing and unchanged
        return {"verdict": "pass" if passed else "fail", "missing_mentions": missing, "source_unchanged": unchanged}
    if work.status != Status.COMPLETED or final is None:
        return {"verdict": "fail", "reason": "no delivery"}
    with tempfile.TemporaryDirectory(prefix="sabre-bench-grade-") as directory:
        target = Path(directory)
        for entry in final["files"]:
            path = target / entry["path"]
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(entry["content"], encoding="utf-8")
        for destination, source in task.grader.files.items():
            path = target / destination
            path.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(suite / source, path)
        result = await executor._run(target, task.grader.argv, 300)
    return {"verdict": "pass" if result.exit_code == 0 else "fail", "exit_code": result.exit_code}


def has_entry(value: Any, key: str, expected: Any) -> bool:
    """Whether any object in a decoded prompt carries key == expected (not merely the same words)."""
    if isinstance(value, dict):
        return value.get(key) == expected or any(has_entry(item, key, expected) for item in value.values())
    if isinstance(value, list):
        return any(has_entry(item, key, expected) for item in value)
    return False


def probes(task: BenchTask, trace: Trace) -> dict:
    """Harness properties a reader can check; they describe behaviour, they do not grade it."""
    developer = trace.first_inputs.get("developer", {})
    qa = trace.first_inputs.get("qa", {})
    plan = task.reference.plan
    order = trace.entries
    first_qa = order.index("agent:qa") if "agent:qa" in order else None
    first_gate = order.index("gate") if "gate" in order else None
    repairs = [opening for role, opening in trace.openings if role == "developer"][1:]
    return {
        # None: no developer repair attempt ran.
        "repair_receives_work_notes": all(has_entry(opening, "kind", "agent_work_notes") for opening in repairs) if repairs else None,
        # None: not applicable (no implementation task in this mode).
        "developer_receives_task_acceptance": has_entry(developer, "acceptance", plan.acceptance) if plan else None,
        "developer_receives_task_scope": has_entry(developer, "scope", plan.scope) if plan else None,
        "deterministic_gates_before_model_qa": first_qa is not None and first_gate is not None and first_gate < first_qa,
        "qa_receives_gate_results": has_entry(qa, "kind", "deterministic_gate_results"),
    }


def budget_feasibility(work: WorkOrder) -> dict:
    """Whether one CLI call (the largest margin) at the context ceiling fits the default token budget."""
    settings = bench_settings()
    reservation = input_reservation_tokens(settings.context_input_max_bytes, cli=True) + settings.model_max_output_tokens
    return {"reservation_at_context_limit": reservation, "budget_max_tokens": work.budget.max_tokens,
            "fits": work.budget.max_tokens is None or reservation <= work.budget.max_tokens}


async def run_task(task: BenchTask, suite: Path = SUITE) -> dict:
    trace = Trace()
    model = ReferenceModel(task=task)
    model._trace = trace
    guard = SecretGuard()
    project = Project(name=f"bench-{task.repo}", repository="https://github.com/sabre-bench/" + task.repo, profile="python",
                      gate_commands=task.gate_commands)
    work = WorkOrder(project_id=project.id, mode=task.mode, objective=task.objective, acceptance=task.acceptance,
                     budget=Budget(max_cost_usd=0), idempotency_key=f"bench-{task.id}")
    repository = BenchRepository(work, project)
    started = time.perf_counter()
    with tempfile.TemporaryDirectory(prefix="sabre-bench-") as directory:
        root = Path(directory)
        executor = LocalExecutor(suite / "repos" / task.repo, root / "workspaces", trace)
        (root / "workspaces").mkdir()
        artifacts = ArtifactStore(root / "artifacts", guard)
        team = AgentTeam(bench_settings(), repository, executor, guard, model_factory=lambda: model,
                         checkpointer=InMemorySaver(), artifacts=artifacts)
        publisher = CapturingPublisher(executor)
        from sabre.workflows import Factory
        factory = Factory(repository, team, executor, NoFindings(), publisher, artifacts, guard, NoMemory(), InMemorySaver())
        result = await factory.drive(work.id)
        saved = (await factory.graph.aget_state(factory.config(work.id))).values.get("work_notes") or {}
        final =publisher.snapshot if task.mode != "audit" else (executor.final_snapshot or await executor.snapshot(work.id))
        grading = await grade(task, suite, executor, result, trace, final)
    wall_ms = int((time.perf_counter() - started) * 1000)
    tools = [event for event in repository.execution_events if event.kind == "tool" and event.state != "started"]
    tool_names = Counter(event.name for event in tools)
    rows = repository.usage_rows
    reserved = [row["reserved"] for row in rows]
    estimated = [row["actual"] or 0 for row in rows]
    sent = [row["sent_bytes"] or 0 for row in rows]
    return {
        "task": task.id, "mode": task.mode, "status": result.status.value, "phase": result.phase, "error_code": result.error_code,
        "grade": grading, "probes": probes(task, trace), "budget_feasibility": budget_feasibility(work), "wall_ms": wall_ms,
        "calls": {"total": len(rows), "by_role": dict(Counter(row["role"] or "unknown" for row in rows))},
        "tokens": {"basis": ESTIMATE_BASIS, "estimated_total": sum(estimated),
                   "estimated_input": sum((row["breakdown"] or {}).get("input_tokens", 0) for row in rows),
                   "estimated_output": sum((row["breakdown"] or {}).get("output_tokens", 0) for row in rows),
                   "reserved_total": sum(reserved), "reserved_max": max(reserved, default=0),
                   "budget_max_tokens": work.budget.max_tokens,
                   "reserved_to_estimated": round(sum(reserved) / sum(estimated), 2) if sum(estimated) else None},
        "context": {"sent_bytes_total": sum(sent), "sent_bytes_max": max(sent, default=0),
                    "original_bytes_total": sum(row["original_bytes"] or 0 for row in rows)},
        "tools": {"calls": dict(tool_names), "failed": sum(event.state == "failed" for event in tools),
                  "output_bytes": sum(event.output_bytes or 0 for event in tools),
                  "total_ms": sum(event.duration_ms or 0 for event in tools)},
        "work_notes": {"scopes": len(saved.get("scopes", {})), "notes": sum(len(notes) for notes in saved.get("scopes", {}).values())},
        "stages": [event.name for event in repository.execution_events if event.kind == "stage" and event.state == "completed"],
        "order": trace.entries,
    }


def load_tasks(suite: Path, selected: list[str] | None = None) -> list[BenchTask]:
    tasks = [BenchTask.model_validate_json(path.read_text(encoding="utf-8")) for path in sorted((suite / "tasks").glob("*.json"))]
    if selected:
        unknown = set(selected) - {task.id for task in tasks}
        if unknown:
            raise DomainError("BENCH_TASK_UNKNOWN", "Unknown bench task: " + ", ".join(sorted(unknown)), 422)
        tasks = [task for task in tasks if task.id in selected]
    return tasks


async def run_suite(suite: Path = SUITE, selected: list[str] | None = None) -> dict:
    results = [await run_task(task, suite) for task in load_tasks(suite, selected)]
    passed = sum(result["grade"]["verdict"] == "pass" for result in results)
    return {"version": 1, "driver": "reference_policy", "token_basis": ESTIMATE_BASIS, "tasks": results,
            "summary": {"tasks": len(results), "passed": passed, "failed": len(results) - passed,
                        "calls": sum(r["calls"]["total"] for r in results),
                        "estimated_tokens": sum(r["tokens"]["estimated_total"] for r in results),
                        "reserved_tokens": sum(r["tokens"]["reserved_total"] for r in results),
                        "tool_output_bytes": sum(r["tools"]["output_bytes"] for r in results)}}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Run SABRE Bench with the reference policy (no model provider is called)")
    parser.add_argument("--suite", type=Path, default=SUITE)
    parser.add_argument("--task", action="append", help="Run only this task id (repeatable)")
    parser.add_argument("--output", type=Path, help="Also write the JSON report to this path")
    args = parser.parse_args(argv)
    try:
        report = asyncio.run(run_suite(args.suite, args.task))
    except DomainError as error:
        print(f"{error.code}: {error.message}", file=sys.stderr)
        return 2
    encoded = json.dumps(report, indent=2, ensure_ascii=False)
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(encoded, encoding="utf-8")
    print(encoded)
    return 0 if report["summary"]["failed"] == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
