"""Owner-authorized repository provisioning followed by the existing create graph.

The stored launch is immutable intent, not another execution state machine.
Repository receipts and LangGraph remain the authorities for their own effects.
"""

import hashlib
import json
from typing import Literal

from psycopg.types.json import Jsonb
from pydantic import Field, field_validator

from sabre.contracts import StrictContract
from sabre.flow_contracts import FlowConfiguration
from sabre.flows import resolve_flow
from sabre.models import Budget, DomainError, Project, WorkOrder, WorkOrderCreate
from sabre.repo_creation import RepoCreationDecision, RepoCreationProposal, RepoCreationRequest


class CreateFlowLaunch(StrictContract):
    version: Literal[1]
    authorize_repository_creation: Literal[True]
    repository: RepoCreationRequest
    profile: Literal["python", "node"]
    gate_commands: list[list[str]] = Field(min_length=1, max_length=12)
    objective: str = Field(min_length=5, max_length=12000)
    acceptance: list[str] = Field(min_length=1, max_length=30)
    constraints: list[str] = Field(default_factory=list, max_length=30)
    budget: Budget
    flow_config: FlowConfiguration = Field(default_factory=FlowConfiguration)
    channel: Literal["web", "mcp", "slack", "api"] = "api"

    @field_validator("authorize_repository_creation", mode="before")
    @classmethod
    def explicit_permission(cls, value):
        if value is not True:
            raise ValueError("Repository creation requires an explicit true permission")
        return value


async def launch_create(service, request: CreateFlowLaunch) -> RepoCreationProposal:
    request = CreateFlowLaunch.model_validate_json(request.model_dump_json(), strict=True)
    service.guard.check(request.model_dump(mode="json"))
    if not request.repository.initialize:
        raise DomainError("INITIALIZED_REPOSITORY_REQUIRED", "A create flow requires an initialized repository", 422)
    proposals = service.repository_proposals()
    signature = hashlib.sha256(json.dumps(request.model_dump(mode="json"), sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    # Replay must use the original selection even after global model changes.
    async with service.repository.connection() as conn:
        prior = await (await conn.execute("""SELECT l.request_digest,p.id FROM repository_flow_launches l
            JOIN repository_proposals p ON p.id=l.proposal_id WHERE p.request_key=%s""",
            (request.repository.idempotency_key,))).fetchone()
    if prior:
        if prior["request_digest"] != signature:
            raise DomainError("CREATE_LAUNCH_CONFLICT", "This launch key is already bound to different details", 409)
        proposal = await proposals.get(prior["id"])
    else:
        project = Project(name=request.repository.name, repository=f"https://github.com/{request.repository.owner}/{request.repository.name}",
            profile=request.profile, gate_commands=request.gate_commands)
        work = WorkOrder(project_id=project.id, mode="create", objective=request.objective,
            acceptance=request.acceptance, constraints=request.constraints, budget=request.budget,
            flow_config=request.flow_config, channel=request.channel, idempotency_key=request.repository.idempotency_key)
        from sabre.console_configuration import pinned_models, prepare_run_configuration
        launch_fields = {key: getattr(work, key) for key in WorkOrderCreate.model_fields}
        if "flow_config" not in request.model_fields_set:
            launch_fields.pop("flow_config")
        launch_request = WorkOrderCreate(**launch_fields)
        if hasattr(service, "model_configuration"):
            work, launch_request = await prepare_run_configuration(service, work, launch_request)
        policy = launch_request.budget.policy or launch_request.flow_config.budget_policy
        if policy is None and hasattr(service, "model_configuration"):
            from sabre.budget_contracts import legacy_policy
            policy = legacy_policy(launch_request.budget, launch_request.flow_config.repair_cycles)
        if policy is not None:
            work.budget.policy = policy.model_copy(deep=True)
            work.effective_budget_policy = policy.model_copy(deep=True)
        work.resolved_flow = await resolve_flow(launch_request.flow_config, "create", service.queue.model_configuration,
                                                service.queue.credentials,
                                                await service.agent_catalog().published() if hasattr(service, "agent_catalog") else None,
                                                pinned_models(work))
        if request.budget.progress_limits and any(phase.model.provider not in {"codex_cli", "claude_cli"} for phase in work.resolved_flow.phases.values()):
            raise DomainError("MODEL_LIMITS_REQUIRED", "API phases require cumulative limits", 422)
        await service.preflight(work, project)
        if not (await service.queue.credentials.resolve("github.create")).get_secret_value():
            raise DomainError("REPOSITORY_CREDENTIAL_REQUIRED", "Configure the repository creation credential before launching", 409)
        proposal = await proposals.propose(request.repository)
        async with service.repository.connection() as conn:
            # A proposal already approved through another channel cannot acquire new work.
            row = await (await conn.execute("SELECT status FROM repository_proposals WHERE id=%s FOR UPDATE", (proposal.id,))).fetchone()
            if row["status"] != "proposed":
                raise DomainError("CREATE_PROPOSAL_CHANGED", "The proposal was already resolved outside this launch", 409)
            stored = await (await conn.execute("""INSERT INTO repository_flow_launches(proposal_id,request_digest,project,work)
                VALUES(%s,%s,%s,%s) ON CONFLICT(proposal_id) DO UPDATE SET proposal_id=EXCLUDED.proposal_id
                RETURNING request_digest""", (proposal.id, signature, Jsonb(project.model_dump(mode="json")), Jsonb(work.model_dump(mode="json"))))).fetchone()
            if stored["request_digest"] != signature:
                raise DomainError("CREATE_LAUNCH_CONFLICT", "This launch key is already bound to different details", 409)
    if proposal.status == "proposed":
        try:
            proposal = await proposals.decide(proposal.id, RepoCreationDecision(expected_revision=proposal.revision,
                request_digest=proposal.request_digest, decision="approve"))
        except DomainError as error:
            if error.code != "REPOSITORY_PROPOSAL_CHANGED":
                raise
            proposal = await proposals.get(proposal.id)
    if proposal.status == "created":
        await continue_create(service, proposal)
    return proposal


async def continue_create(service, proposal: RepoCreationProposal):
    if proposal.status != "created" or not proposal.receipt:
        return
    async with service.repository.connection() as conn:
        row = await (await conn.execute("SELECT project,work FROM repository_flow_launches WHERE proposal_id=%s", (proposal.id,))).fetchone()
    if not row:
        return
    project = Project.model_validate(row["project"])
    project = Project.model_validate({**project.model_dump(), "default_branch": proposal.receipt.default_branch})
    work = WorkOrder.model_validate(row["work"])
    # Fixed IDs and the admission key make post-receipt retries safe.
    try:
        await service.repository.create_project(project, enqueue=getattr(service.queue, "enqueue_ingestion", None))
    except DomainError as error:
        if error.code != "PROJECT_EXISTS":
            raise
        current = await service.repository.project(project.id)
        if current.model_dump() != project.model_dump():
            raise DomainError("CREATE_PROJECT_CHANGED", "The registered project differs from the authorized launch", 409) from None
    await service.repository.admit(work, service.enqueue)
