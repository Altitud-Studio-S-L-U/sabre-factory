"""MCP is an application adapter; it never holds a factory run open in a tool request."""

from typing import Annotated, Any, Literal

from mcp.server import MCPServer
from mcp.server.mcpserver import Elicit, ElicitationResult, Resolve
from pydantic import Field

from sabre import __version__
from sabre.audit import AuditView, ProjectKnowledgeReport
from sabre.commands import CommandEnvelope, CommandResult, dispatch
from sabre.create_flow import CreateFlowLaunch, launch_create
from sabre.events import EventPage
from sabre.integrations import (
    GitHubRepositoryImport,
    GitHubRepositoryPage,
    GitHubRepositorySearch,
    IntegrationInfo,
)
from sabre.mcp_connections import MCPConnectionInfo, MCPConnectionSave, MCPDiscovery
from sabre.model_configuration import ModelConfiguration, ModelConfigurationChange
from sabre.models import (
    Answer,
    CallBudgetIncrease,
    CliProgressLimitsChange,
    Contract,
    DomainError,
    MemoryCreate,
    MemoryItem,
    Project,
    ProjectCreate,
    ScopeChange,
    SecurityException,
    SecurityExceptionCreate,
    TokenBudgetIncrease,
    WorkOrder,
    WorkOrderCreate,
)
from sabre.operator_contracts import (
    OperatorMessagePage,
    OperatorMessageRequest,
    OperatorMessageResume,
    OperatorMessageView,
)
from sabre.project_tools import ProjectToolsChange, ProjectToolsPolicy
from sabre.repo_creation import (
    RepoCreationDecision,
    RepoCreationPage,
    RepoCreationProposal,
    RepoCreationRequest,
)
from sabre.system_info import SystemInfo


class NativeAnswer(Contract):
    answer: str = Field(min_length=1, max_length=12000, description="Owner response to this decision")


def build_mcp(service):
    server = MCPServer("SABRE", version=__version__, instructions=(
        "SABRE is a software factory. Submit a work order and use its returned id for status, tasks, questions and results. "
        "Work continues after disconnect. Answer only the pending question matching its id and plan revision. "
        "Never send passwords, API keys or access tokens as tool arguments."
    ))

    @server.tool(structured_output=True)
    async def sabre_command(command: CommandEnvelope) -> CommandResult:
        """Execute a versioned owner command. Preserve its key and correlation ID on retry; never invent approval."""
        return await dispatch(service(), command)

    @server.tool(structured_output=True)
    async def sabre_list_projects() -> list[Project]:
        """List the owner's registered projects."""
        return [p for p in await service().repository.projects()]

    @server.tool(structured_output=True)
    async def sabre_system_info() -> SystemInfo:
        """Inspect installed versions, observed service status and execution limits without starting work."""
        return (await service().system_info())

    @server.tool(structured_output=True)
    async def sabre_get_model_configuration() -> ModelConfiguration:
        """Inspect default and role-specific models, explicit destinations, revision and CLI session status. No inference or login is started."""
        return (await service().get_model_configuration())

    @server.tool(structured_output=True)
    async def sabre_talk_supervisor(request: OperatorMessageRequest) -> OperatorMessageView:
        """Send an authenticated owner's durable message. Mutations require explicit allowed_actions; messages never grant budget or policy increases."""
        return await service().queue.operator_conversation.admit(request)

    @server.tool(structured_output=True)
    async def sabre_supervisor_messages(work_id: str | None = None) -> OperatorMessagePage:
        """Read the owner's factory or selected-run conversation. No inference or mutation starts."""
        return await service().queue.operator_conversation.list(work_id)

    @server.tool(structured_output=True)
    async def sabre_resume_supervisor_message(message_id: str, request: OperatorMessageResume) -> OperatorMessageView:
        """Owner-authorized checkpoint reconciliation and resumption with the original action grants. Does not expand budgets or permissions."""
        return await service().queue.operator_conversation.resume(message_id, request)

    @server.tool(structured_output=True)
    async def sabre_set_model_configuration(request: ModelConfigurationChange) -> ModelConfiguration:
        """Apply the owner's explicitly approved model destinations with revision checking. Never invent approval or send credentials. Does not start work or authentication."""
        return (await service().change_model_configuration(request))

    @server.tool(structured_output=True)
    async def sabre_audit_work(work_id: str) -> AuditView:
        """Inspect recorded agents, tool responses and measured or unknown usage. No prompts or tool arguments are returned."""
        return (await service().audit_service().audit(work_id))

    @server.tool(structured_output=True)
    async def sabre_project_knowledge(project_id: str) -> ProjectKnowledgeReport:
        """Inspect checkpoint continuity, recorded source context and approved memory counts. Recorded context is not proof of current source freshness."""
        return (await service().audit_service().knowledge(project_id))

    @server.tool(structured_output=True)
    async def sabre_list_integrations() -> list[IntegrationInfo]:
        """List configured integrations, enabled state, role permissions and credential metadata, never secret values."""
        return [item for item in await service().integrations().list()]

    @server.tool(structured_output=True)
    async def sabre_list_mcp_connections() -> list[MCPConnectionInfo]:
        """Inspect registered MCP endpoints and reviewed tool policies, without secret values."""
        return [item for item in await service().mcp_connections().list()]

    @server.tool(structured_output=True)
    async def sabre_save_mcp_connection(name: str, request: MCPConnectionSave) -> MCPConnectionInfo:
        """Save an owner-reviewed public HTTPS MCP connection. Always disables it; never grants project access. Selected tools require discovered manifest digests."""
        return (await service().save_mcp_connection(name, request))

    @server.tool(structured_output=True)
    async def sabre_discover_mcp_tools(name: str, expected_revision: int) -> MCPDiscovery:
        """Read a dynamic MCP server's bounded untrusted manifest for owner review. Does not execute tools or activate the connection."""
        return (await service().mcp_connections().discover(name, expected_revision, service()._credentials()))

    @server.tool(structured_output=True)
    async def sabre_propose_repository(request: RepoCreationRequest) -> RepoCreationProposal:
        """Prepare an immutable GitHub repository proposal for HITL. No repository is created until the owner approves these exact details."""
        return (await service().repository_proposals().propose(request))

    @server.tool(structured_output=True)
    async def sabre_list_repository_proposals() -> RepoCreationPage:
        """Inspect durable pending approvals and repository creation outcomes, including uncertain effects requiring reconciliation."""
        return (await service().repository_proposals().list())

    @server.tool(structured_output=True)
    async def sabre_launch_create(request: CreateFlowLaunch) -> RepoCreationProposal:
        """Create the explicitly authorized repository and launch its pinned create flow."""
        return await launch_create(service(), request)

    @server.tool(structured_output=True)
    async def sabre_get_repository_proposal(proposal_id: str) -> RepoCreationProposal:
        """Recover a durable proposal or receipt by id, even after it leaves the recent list."""
        return (await service().repository_proposals().get(proposal_id))

    @server.tool(structured_output=True)
    async def sabre_project_mcp_tools(project_id: str) -> ProjectToolsPolicy:
        """Read the project's explicit MCP server permissions and revision."""
        return (await service().project_tools().get(project_id))

    @server.tool(structured_output=True)
    async def sabre_set_project_mcp_tools(project_id: str, change: ProjectToolsChange) -> ProjectToolsPolicy:
        """Change owner-authorized project MCP permissions with revision checking while the project is idle. Does not activate servers."""
        return (await service().project_tools().change(project_id, change))

    @server.tool(structured_output=True)
    async def sabre_decide_repository(proposal_id: str, decision: RepoCreationDecision) -> RepoCreationProposal:
        """Record the owner's explicit approve/reject decision matching the current revision and digest. Never invent approval. Approval queues creation and returns immediately."""
        return (await service().repository_proposals().decide(proposal_id, decision))

    @server.tool(structured_output=True)
    async def sabre_reconcile_repository(proposal_id: str) -> RepoCreationProposal:
        """Read GitHub to inspect an uncertain creation outcome; never repeats the creation POST or adopts an unproven existing repository."""
        return (await service().repository_proposals().reconcile(proposal_id))

    @server.tool(structured_output=True)
    async def sabre_find_github_repositories(request: GitHubRepositorySearch) -> GitHubRepositoryPage:
        """List GitHub repositories for a user or organization. User lists are public; private organization access requires a dedicated read credential."""
        return (await service().integrations().github_repositories(request))

    @server.tool(structured_output=True)
    async def sabre_import_github_repository(request: GitHubRepositoryImport) -> Project:
        """Register an owner-selected existing repository after verifying its canonical URL and branch. Does not launch work or create a remote repository."""
        project = await service().integrations().github_import(request)
        return (await service().create_project(project))

    @server.tool(structured_output=True)
    async def sabre_create_project(request: ProjectCreate) -> Project:
        """Register an owner-authorized GitHub repository and its verification commands."""
        return (await service().create_project(request))

    @server.tool(structured_output=True)
    async def sabre_flow_schema() -> dict[str, Any]:
        """Read the strict versioned launch configuration schema."""
        from sabre.flows import flow_schema
        return flow_schema()

    @server.tool(structured_output=True)
    async def sabre_execution_events(work_id: str, after: int = 0, limit: int = 100) -> EventPage:
        """Read measured phase and tool events incrementally; retain next_cursor for polling."""
        await service().repository.work(work_id)
        return (await service().repository.execution_events(work_id, after, limit))

    @server.tool(structured_output=True)
    async def sabre_submit_work(request: WorkOrderCreate) -> WorkOrder:
        """Start CREATE, MAINTAIN, PATCH or read-only AUDIT work; returns immediately with a durable id. Set channel=mcp."""
        return (await service().submit(request))

    @server.tool(structured_output=True)
    async def sabre_list_work() -> list[WorkOrder]:
        """List work orders with current phase, blockers and summary."""
        return [w for w in await service().repository.works()]

    @server.tool(structured_output=True)
    async def sabre_get_work(work_id: str) -> WorkOrder:
        """Get supervisor status, tasks, subtasks, pending questions, findings and delivery evidence."""
        return (await service().repository.work(work_id))

    @server.tool(structured_output=True)
    async def sabre_answer_question(work_id: str, answer: Answer) -> WorkOrder:
        """Resolve the owner's pending HITL decision; stale or duplicated answers are rejected."""
        return (await service().answer(work_id, answer))

    @server.tool(structured_output=True)
    async def sabre_control_work(work_id: str, command: Literal["pause", "resume", "cancel"]) -> WorkOrder:
        """Request pause, resume or cancel. A running operation stops at a safe boundary."""
        return (await service().control(work_id, command))

    async def ask_native(work_id: str, question_id: str, plan_revision: int):
        work = await service().repository.work(work_id)
        question = next((q for q in work.questions if q.id == question_id), None)
        if work.status != "waiting_input" or work.plan_revision != plan_revision or not question or question.plan_revision != plan_revision or question.answer is not None:
            raise DomainError("QUESTION_CLOSED", "The question is no longer pending in this revision")
        return Elicit(question.prompt, NativeAnswer)

    @server.tool(structured_output=True)
    async def sabre_resolve_question_native(work_id: str, question_id: str, plan_revision: int,
        reply: Annotated[ElicitationResult[NativeAnswer], Resolve(ask_native)]) -> WorkOrder:
        """Ask the owner through native MCP elicitation when supported. Otherwise use sabre_answer_question."""
        if reply.action != "accept":
            return await service().repository.work(work_id)
        return (await service().answer(work_id, Answer(question_id=question_id, plan_revision=plan_revision, answer=reply.data.answer)))

    @server.resource("sabre://work/{work_id}")
    async def work_resource(work_id: str) -> str:
        """Read an authenticated work order's current supervisor state."""
        return (await service().repository.work(work_id)).model_dump_json()

    @server.tool(structured_output=True)
    async def sabre_change_scope(work_id: str, change: ScopeChange) -> WorkOrder:
        """Revise the objective of paused work, invalidating prior decisions and evidence."""
        return (await service().change_scope(work_id, change))

    @server.tool(structured_output=True)
    async def sabre_increase_token_budget(work_id: str, change: TokenBudgetIncrease) -> WorkOrder:
        """Apply the owner's explicit approval to increase only max_tokens on paused or blocked work. Never approve automatically. Revision and previous limit must match. Usage, reservations and other limits remain unchanged; resume separately."""
        return (await service().increase_token_budget(work_id, change))

    @server.tool(structured_output=True)
    async def sabre_increase_call_budget(work_id: str, change: CallBudgetIncrease) -> WorkOrder:
        """Apply the owner's explicit approval to increase only max_calls on paused or blocked work. Never approve automatically. Revision and previous limit must match. Usage, reservations and other limits remain unchanged; resume separately."""
        return (await service().increase_call_budget(work_id, change))

    @server.tool(structured_output=True)
    async def sabre_use_cli_progress_limits(work_id: str, change: CliProgressLimitsChange) -> WorkOrder:
        """Only after an explicit owner instruction: replace cumulative quotas with CLI progress controls. Preserves usage, requires the current plan and full budget, and does not resume the work."""
        return (await service().use_cli_progress_limits(work_id, change))

    @server.tool(structured_output=True)
    async def sabre_security_findings(project_id: str | None = None) -> list[dict]:
        """Read findings and recommendations from the independent security chain."""
        return await service().repository.security(project_id)

    @server.tool(structured_output=True)
    async def sabre_security_exceptions(work_id: str) -> list[SecurityException]:
        """List owner-approved, expiring security exceptions for this work order."""
        return [item for item in await service().repository.security_exceptions(work_id)]

    @server.tool(structured_output=True)
    async def sabre_approve_security_exception(work_id: str, request: SecurityExceptionCreate) -> SecurityException:
        """Record the owner's explicit risk acceptance for an exact finding/snapshot/rules/revision, for at most 30 days. Never approve automatically. Secrets and scanner failures cannot be waived. Resume separately to review again."""
        return (await service().approve_security_exception(work_id, request))

    @server.tool(structured_output=True)
    async def sabre_revoke_security_exception(work_id: str, exception_id: str) -> SecurityException:
        """Revoke an owner's security exception; any pending delivery must satisfy current policy."""
        return (await service().revoke_security_exception(work_id, exception_id))

    @server.tool(structured_output=True)
    async def sabre_search_memory(project_id: str, query: str, commit: str) -> list[dict]:
        """Retrieve active project knowledge valid for the specified source commit."""
        return await service().memory.search(project_id, query, commit)

    @server.tool(structured_output=True)
    async def sabre_propose_memory(request: MemoryCreate) -> MemoryItem:
        """Propose a source-linked memory; lessons require explicit owner approval."""
        return (await service().memory.propose(request))

    @server.tool(structured_output=True)
    async def sabre_resolve_memory(memory_id: str, approve: bool) -> MemoryItem:
        """Approve or invalidate a memory as the authenticated owner."""
        return (await service().memory.update(memory_id, approve))

    return server
