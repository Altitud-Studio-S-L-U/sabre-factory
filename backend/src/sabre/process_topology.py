"""Registered presentation of the executable graph; expected lanes are not execution evidence."""

from typing import Literal

from pydantic import Field

from sabre.contracts import StrictContract


class ProcessLane(StrictContract):
    id: str
    label: str
    specialist: str
    stages: list[str]
    next: list[str] = Field(default_factory=list)


class ProcessRoute(StrictContract):
    source: str
    target: str
    condition: str


StationKind = Literal["rules", "gates", "model", "gates_model"]
StageId = Literal["understand", "plan", "build", "verify", "review", "security", "deliver"]


class ProcessHelper(StrictContract):
    """A specialist a station may call besides its own, and when."""
    role: str
    agent: str
    condition: str


class ProcessStation(StrictContract):
    """One node of the sabre-v1 graph as the owner sees it. Routing is deterministic: no model chooses edges."""
    id: str
    label: str
    stage: StageId
    kind: StationKind
    role: str | None = None
    agent: str | None = None
    summary: str
    phases: list[str]
    condition: str | None = None
    asks_owner: bool = False
    helpers: list[ProcessHelper] = Field(default_factory=list)


class ProcessLoop(StrictContract):
    source: str
    target: str
    condition: str
    limit: str


class ProcessTopology(StrictContract):
    version: Literal[1] = 1
    graph_version: Literal["sabre-v1"] = "sabre-v1"
    mode: Literal["patch", "maintain", "create", "audit"]
    lanes: list[ProcessLane]
    alternatives: list[ProcessRoute]
    stations: list[ProcessStation] = Field(default_factory=list)
    loops: list[ProcessLoop] = Field(default_factory=list)


# Catalog agent behind each workflow role (agent_catalog.ROLE_ADAPTERS), named as the console shows it.
AGENTS = {"analyst": "PM", "architect": "Developer", "supervisor": "Supervisor", "developer": "Developer", "qa": "QA",
          "reviewer": "Supervisor", "security": "CISO", "designer": "Designer", "devops": "DevOps"}


def _station(id, label, stage, kind, summary, phases, role=None, **extra):
    return ProcessStation(id=id, label=label, stage=stage, kind=kind, summary=summary, phases=phases, role=role,
                          agent=AGENTS.get(role) if role else None, **extra)


def process_stations(mode):
    """Stations in graph order for one mode (workflows.FactoryWorkflow.graph). Clarify nodes are the asks_owner flag."""
    stations = [_station("intake", "Intake", "understand", "rules", "Pin the snapshot, flow and source index.", ["intake"])]
    if mode == "patch":
        stations.append(_station("reproduce", "Reproduce", "understand", "gates", "Run the registered checks to capture the failure.",
                                 ["reproduction"], condition="Patch runs with a resolved flow"))
    stations.append(_station("analyze", "Analyze", "understand", "model", "Define requirements and unresolved questions.",
                             ["analysis", "clarification"], "analyst", asks_owner=True))
    if mode == "create":
        stations.extend([
            _station("design", "Design", "plan", "model", "Compare options and propose the stack and structure.",
                     ["design", "design_clarification"], "architect", asks_owner=True),
            _station("architecture", "Architecture", "plan", "rules", "Approve the proposal, or ask you when the flow requires it.",
                     ["architecture_approval"], asks_owner=True),
        ])
    if mode != "audit":
        stations.extend([
            _station("plan", "Plan", "plan", "model", "Split the work into a dependency graph of developer tasks.",
                     ["planning", "plan_clarification"], "supervisor", asks_owner=True,
                     helpers=[ProcessHelper(role="designer", agent="Designer", condition="UX phase resolved and a UI objective")]),
            _station("implement", "Implement", "build", "model", "Implement one planned task per pass.",
                     ["implementation", "task_clarification", "repair"], "developer", asks_owner=True),
        ])
    stations.extend([
        _station("checks", "Checks", "verify", "gates_model", "Run registered checks; QA reviews their evidence only if all pass.",
                 ["verification", "qa_clarification"], "qa", asks_owner=True),
        _station("scope_guard", "Scope guard", "verify", "rules", "Stop for your permission when changes leave the approved scope.",
                 ["scope_check", "scope_approval"], asks_owner=True),
        _station("review", "Review", "review", "model", "Independent review in a separate invocation.",
                 ["review", "review_clarification"], "reviewer", asks_owner=True),
        _station("security", "Security", "security", "gates_model", "Scanners collect findings; the CISO triages them.",
                 ["security"], "security"),
    ])
    if mode == "audit":
        stations.append(_station("audit_report", "Report", "deliver", "rules", "Report checks and findings; nothing is published.",
                                 ["audit_report"]))
    else:
        stations.extend([
            _station("route", "Route", "deliver", "rules", "Ready to deliver, or send the last task back for repair.", ["decision"]),
            _station("commit", "Commit", "deliver", "rules", "Re-verify the snapshot and prepare the commit.", ["prepare_delivery"],
                     helpers=[ProcessHelper(role="devops", agent="DevOps", condition="Delivery preparation phase resolved")]),
            _station("deliver", "Deliver", "deliver", "rules", "Open a draft pull request from verified evidence.", ["delivery"]),
            _station("remember", "Remember", "deliver", "rules", "Propose a fact tied to the delivered evidence.", []),
        ])
    return stations


def process_loops(mode):
    if mode == "audit":
        return []
    return [ProcessLoop(source="route", target="implement", condition="A gate, QA, review or security check did not pass",
                        limit="Repair cycles of the flow (0-2); stops on NO_PROGRESS, REPAIR_LIMIT or the repairs budget"),
            ProcessLoop(source="implement", target="implement", condition="Planned tasks remain", limit="One task per pass")]


def process_topology(mode):
    lanes = [ProcessLane(id="preflight", label="Preflight", specialist="System", stages=["intake"])]
    if mode == "patch":
        lanes.append(ProcessLane(id="reproduce", label="Reproduce", specialist="Registered checks", stages=["reproduce", "reproduction"]))
    lanes.append(ProcessLane(id="spec", label="Spec", specialist="PM", stages=["analyze", "analysis", "clarify"]))
    if mode == "create":
        lanes.append(ProcessLane(id="design", label="Design", specialist="Designer · Developer", stages=["design", "design_clarify", "architecture", "designer"]))
    if mode != "audit":
        lanes.extend([
            ProcessLane(id="plan", label="Plan", specialist="Supervisor", stages=["plan", "planning", "plan_clarify"]),
            ProcessLane(id="build", label="Build", specialist="Developer", stages=["implement", "implementation", "task_clarify", "repair"]),
        ])
    lanes.extend([
        ProcessLane(id="verify", label="Verify", specialist="QA", stages=["checks", "verification", "qa_clarify"]),
        ProcessLane(id="review", label="Review", specialist="Supervisor · independent review", stages=["scope_guard", "scope_approval", "review", "review_clarify"]),
        ProcessLane(id="security", label="Security", specialist="CISO", stages=["security_check", "security"]),
    ])
    if mode == "audit":
        lanes.append(ProcessLane(id="report", label="Report", specialist="System", stages=["audit_report"]))
    else:
        lanes.extend([
            ProcessLane(id="deliver", label="Deliver", specialist="DevOps · controlled publication", stages=["devops", "delivery_preparation", "route", "commit", "prepare_delivery", "deliver", "delivery"]),
            ProcessLane(id="memory", label="Memory", specialist="Verified evidence", stages=["remember", "memory"]),
        ])
    for current, following in zip(lanes, lanes[1:], strict=False):
        current.next = [following.id]
    alternatives = [ProcessRoute(source="spec", target="spec", condition="Required human input")]
    if mode != "audit":
        alternatives.extend([
            ProcessRoute(source="review", target="build", condition="Repair authorized within run limits"),
            ProcessRoute(source="security", target="build", condition="Blocking finding requires repair"),
            ProcessRoute(source="build", target="build", condition="Task dependency or safe retry"),
        ])
    return ProcessTopology(mode=mode, lanes=lanes, alternatives=alternatives, stations=process_stations(mode),
                           loops=process_loops(mode))
