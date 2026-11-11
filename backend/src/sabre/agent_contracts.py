"""Versioned specialist procedures and bounded domain exchange envelopes."""

from typing import Annotated, Literal

from pydantic import Field, model_validator

from sabre.contracts import StrictContract
from sabre.model_selection import ModelSelection
from sabre.phase_results import AnalysisResult, ImplementationResult, PlanningResult, ReviewResult

AgentId = Literal["pm", "designer", "developer", "qa", "manager", "devops", "ciso"]
SkillName = Literal["engineering", "verification", "review", "security"]
Capability = Literal["requirements", "design", "architecture", "planning", "implementation", "verification", "review", "delivery", "security"]
Identifier = Annotated[str, Field(min_length=1, max_length=128, pattern=r"^[A-Za-z0-9._:/-]+$")]
Digest = Annotated[str, Field(pattern=r"^[a-f0-9]{64}$")]


class SkillReference(StrictContract):
    name: SkillName
    digest: Digest


class AgentContextPolicy(StrictContract):
    max_input_bytes: int = Field(default=98304, ge=4096, le=98304)
    visual_review: bool = False


class ChainStep(StrictContract):
    version: Literal[1]
    id: Identifier
    capability: Capability
    instructions: str = Field(default="", max_length=8000)


class ChainDefinition(StrictContract):
    version: Literal[1]
    id: Capability
    steps: list[ChainStep] = Field(min_length=1, max_length=4)

    @model_validator(mode="after")
    def registered_steps(self):
        if len({step.id for step in self.steps}) != len(self.steps):
            raise ValueError("Chain step identifiers must be unique")
        if any(step.capability != self.id for step in self.steps):
            raise ValueError("Every step must use the chain's registered capability")
        return self


class AgentDefinition(StrictContract):
    version: Literal[1]
    id: AgentId
    label: str = Field(min_length=1, max_length=80)
    instructions: str = Field(min_length=1, max_length=16000)
    chains: list[ChainDefinition] = Field(min_length=1, max_length=3)
    skills: list[SkillReference] = Field(default_factory=list, max_length=4)
    model: ModelSelection | None = None
    tools: list[Identifier] | None = Field(default=None, max_length=128)
    context: AgentContextPolicy = Field(default_factory=AgentContextPolicy)

    @model_validator(mode="after")
    def unique_selections(self):
        if len({chain.id for chain in self.chains}) != len(self.chains):
            raise ValueError("Chain identifiers must be unique")
        if len({skill.name for skill in self.skills}) != len(self.skills):
            raise ValueError("Skill names must be unique")
        if self.tools is not None and len(set(self.tools)) != len(self.tools):
            raise ValueError("Tool names must be unique")
        return self


class AgentDefinitionSnapshot(StrictContract):
    version: int = Field(ge=1)
    digest: Digest
    definition: AgentDefinition


class AgentValidation(StrictContract):
    valid: bool
    errors: list[str] = Field(default_factory=list, max_length=30)


class AgentCatalogEntry(StrictContract):
    id: AgentId
    label: str
    legacy_roles: list[str]
    revision: int = Field(ge=0)
    draft: AgentDefinition
    published: AgentDefinitionSnapshot
    versions: list[AgentDefinitionSnapshot]
    validation: AgentValidation


class AgentCatalog(StrictContract):
    version: Literal[1] = 1
    agents: list[AgentCatalogEntry]


class AgentDraftSave(StrictContract):
    expected_revision: int = Field(ge=0)
    definition: AgentDefinition


class AgentRevision(StrictContract):
    expected_revision: int = Field(ge=0)


class ArtifactReference(StrictContract):
    version: Literal[1]
    id: Identifier
    digest: Digest
    media_type: str = Field(min_length=1, max_length=128, pattern=r"^[a-zA-Z0-9.+-]+/[a-zA-Z0-9.+-]+$")
    size_bytes: int = Field(ge=0, le=1073741824)
    name: str = Field(min_length=1, max_length=256)


class AgentMessage(StrictContract):
    version: Literal[1]
    run_id: Identifier
    step_id: Identifier
    attempt: int = Field(ge=1, le=50)
    sender: AgentId
    recipient: AgentId
    correlation_id: Identifier
    content: str = Field(min_length=1, max_length=16000)
    artifacts: list[ArtifactReference] = Field(default_factory=list, max_length=30)


class StepResult(StrictContract):
    version: Literal[1]
    run_id: Identifier
    step_id: Identifier
    attempt: int = Field(ge=1, le=50)
    sender: AgentId
    recipient: AgentId
    correlation_id: Identifier
    capability: Capability
    result: AnalysisResult | ImplementationResult | PlanningResult | ReviewResult
    artifacts: list[ArtifactReference] = Field(default_factory=list, max_length=30)

    @model_validator(mode="after")
    def compatible_result(self):
        expected = {"requirements": AnalysisResult, "design": AnalysisResult, "architecture": AnalysisResult,
                    "planning": PlanningResult, "implementation": ImplementationResult,
                    "verification": ReviewResult, "review": ReviewResult, "delivery": ReviewResult,
                    "security": ReviewResult}[self.capability]
        if type(self.result) is not expected:
            raise ValueError("Result does not match the registered capability")
        return self
