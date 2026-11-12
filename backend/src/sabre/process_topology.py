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


class ProcessTopology(StrictContract):
    version: Literal[1] = 1
    graph_version: Literal["sabre-v1"] = "sabre-v1"
    mode: Literal["patch", "maintain", "create", "audit"]
    lanes: list[ProcessLane]
    alternatives: list[ProcessRoute]


def process_topology(mode):
    lanes = [ProcessLane(id="preflight", label="Preflight", specialist="System", stages=["intake"])]
    if mode == "patch":
        lanes.append(ProcessLane(id="reproduce", label="Reproduce", specialist="QA", stages=["reproduce", "reproduction"]))
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
    return ProcessTopology(mode=mode, lanes=lanes, alternatives=alternatives)
