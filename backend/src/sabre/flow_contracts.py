"""Versioned launch configuration; executable topology remains in the graph."""

from typing import Literal

from pydantic import Field, model_validator

from sabre.contracts import StrictContract
from sabre.model_selection import ModelSelection

Phase = Literal["analysis", "design", "planning", "implementation", "verification", "review", "security"]
PHASE_ROLES: dict[Phase, str] = {"analysis": "analyst", "design": "architect", "planning": "supervisor",
               "implementation": "developer", "verification": "qa", "review": "reviewer", "security": "security"}
FLOW_VERSION: Literal["sabre-factory-v1"] = "sabre-factory-v1"


class FlowPhase(StrictContract):
    model: ModelSelection | None = None
    skills: list[Literal["engineering", "verification", "review", "security"]] = Field(default_factory=list, max_length=4)


class FlowPermissions(StrictContract):
    architecture: bool = True
    dependency_changes: bool = False
    draft_pull_request: bool = True


class FlowConfiguration(StrictContract):
    version: Literal[1] = 1
    phases: dict[Phase, FlowPhase] = Field(default_factory=dict)
    phase_models: dict[Phase, ModelSelection] = Field(default_factory=dict)
    permissions: FlowPermissions = Field(default_factory=FlowPermissions)
    repair_cycles: int = Field(default=2, ge=0, le=2)

    @model_validator(mode="after")
    def unique_skills(self):
        for phase in self.phases.values():
            if len(phase.skills) != len(set(phase.skills)):
                raise ValueError("A phase cannot select the same skill twice")
        return self


class ResolvedPhase(StrictContract):
    role: str
    model: ModelSelection
    credential_target: str | None
    skills: dict[str, str]


class ResolvedFlow(StrictContract):
    version: Literal[1] = 1
    flow_version: Literal["sabre-factory-v1"] = FLOW_VERSION
    graph_version: Literal["sabre-v1"] = "sabre-v1"
    model_revision: int = Field(ge=0)
    phases: dict[Phase, ResolvedPhase]
    configuration_digest: str = Field(pattern=r"^[a-f0-9]{64}$")


class FlowYamlRequest(StrictContract):
    document: str = Field(min_length=1, max_length=65536)
