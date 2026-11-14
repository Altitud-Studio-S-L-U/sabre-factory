"""MCP is an application adapter; it never holds a factory run open in a tool request."""

from typing import Annotated, Any, Literal

from mcp.server.mcpserver import Elicit, ElicitationResult, Resolve
from pydantic import Field

from sabre import __version__
from sabre.audit import AuditView, ProjectKnowledgeReport
from sabre.budget_contracts import BudgetAmendment, BudgetReconciliation
from sabre.commands import AmendBudget, CommandEnvelope, CommandResult, ReconcileBudget, dispatch
from sabre.create_flow import CreateFlowLaunch
from sabre.events import EventPage
from sabre.integrations import (
    GitHubRepositoryImport,
    GitHubRepositoryPage,
    GitHubRepositorySearch,
    IntegrationInfo,
)
from sabre.mcp_connections import MCPConnectionInfo, MCPConnectionSave, MCPDiscovery
from sabre.mcp_errors import DomainMCPServer
from sabre.memory_contracts import MemoryGraph, MemoryRecallPage, MemoryReview
from sabre.model_configuration import ModelConfiguration, ModelConfigurationChange
from sabre.models import (
    MEMORY_ID_PATTERN,
    OWNER_DECISIONS,
    Answer,
    CallBudgetIncrease,
    CliProgressLimitsChange,
    Contract,
    DomainError,
    MemoryCreate,
    MemoryItem,
    Project,
    ProjectCreate,
    ProposedBy,
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
from sabre.owner_confirmations import OwnerConfirmation, OwnerConfirmationPage
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
    server = DomainMCPServer("SABRE", version=__version__, instructions=(
        "SABRE is a software factory. Submit a work order and use its returned id for status, tasks, questions and results. "
        "Work continues after disconnect. Answer only the pending question matching its id and plan revision. "
        "Budget changes, security exceptions, answers to owner decisions and repository creation requested here change nothing "
        "until the owner confirms them in the SABRE console: follow the request with sabre_confirmation and never assume approval. "
        "Never send passwords, API keys or access tokens as tool arguments."
    ))

    @server.tool(structured_output=True)
    async def sabre_command(command: CommandEnvelope) -> CommandResult:
        """Execute a versioned owner command. Preserve its key and correlation ID on retry; never invent approval. Budget commands are refused here: use sabre_amend_budget or sabre_reconcile_budget, which wait for the owner."""
        if isinstance(command.payload, (AmendBudget, ReconcileBudget)):
            raise DomainError("OWNER_CONFIRMATION_REQUIRED", "Budget commands over MCP wait for the owner: use sabre_amend_budget or sabre_reconcile_budget", 403)
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
        return await service().queue.operator_conversation.admit(request, source="mcp")

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
    async def sabre_launch_create(request: CreateFlowLaunch) -> OwnerConfirmation:
        """Ask the owner to create this repository and launch its pinned create flow. Nothing is created until the owner confirms it in the SABRE console."""
        return await service().owner_confirmations().request("repository.launch", None, request)

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
        """Reject a repository proposal matching the current revision and digest. An approval is refused here: file it with sabre_propose_repository_approval, which waits for the owner."""
        if decision.decision == "approve":
            raise DomainError("OWNER_CONFIRMATION_REQUIRED", "Repository creation waits for the owner: use sabre_propose_repository_approval", 403)
        return (await service().repository_proposals().decide(proposal_id, decision))

    @server.tool(structured_output=True)
    async def sabre_propose_repository_approval(proposal_id: str, decision: RepoCreationDecision) -> OwnerConfirmation:
        """Ask the owner to approve a repository proposal matching its current revision and digest. No repository is created until the owner confirms it in the SABRE console."""
        return await service().owner_confirmations().request_repository(proposal_id, decision)

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
        """Answer a pending clarification question; stale or duplicated answers are rejected. Owner decisions (architecture, permission, scope, exception) are refused here: file them with sabre_propose_answer, which waits for the owner."""
        work = await service().repository.work(work_id)
        if any(question.id == answer.question_id and question.kind in OWNER_DECISIONS for question in work.questions):
            raise DomainError("OWNER_CONFIRMATION_REQUIRED", "This question is an owner decision: use sabre_propose_answer and the owner confirms it in the console", 403)
        return (await service().answer(work_id, answer))

    @server.tool(structured_output=True)
    async def sabre_propose_answer(work_id: str, answer: Answer) -> OwnerConfirmation:
        """Ask the owner to record this answer to a pending owner decision (architecture, permission, scope or exception). Nothing changes until the owner confirms it in the SABRE console."""
        return await service().owner_confirmations().request_answer(work_id, answer)

    @server.tool(structured_output=True)
    async def sabre_control_work(work_id: str, command: Literal["pause", "resume", "cancel"]) -> WorkOrder:
        """Request pause, resume or cancel. A running operation stops at a safe boundary."""
        return (await service().control(work_id, command))

    async def ask_native(work_id: str, question_id: str, plan_revision: int):
        work = await service().repository.work(work_id)
        question = next((q for q in work.questions if q.id == question_id), None)
        if work.status != "waiting_input" or work.plan_revision != plan_revision or not question or question.plan_revision != plan_revision or question.answer is not None:
            raise DomainError("QUESTION_CLOSED", "The question is no longer pending in this revision")
        if question.kind in OWNER_DECISIONS:
            raise DomainError("OWNER_CONFIRMATION_REQUIRED", "This question is an owner decision: use sabre_propose_answer and the owner confirms it in the console", 403)
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
    async def sabre_increase_token_budget(work_id: str, change: TokenBudgetIncrease) -> OwnerConfirmation:
        """Ask the owner to increase only max_tokens on paused or blocked work that has no budget policy (effective_budget_policy is null); a run with a policy is refused here with VERSIONED_BUDGET_REQUIRED and takes sabre_amend_budget. Nothing changes until the owner confirms it in the SABRE console. Revision and previous limit must still match then. Usage, reservations and other limits remain unchanged; resume separately."""
        return await service().owner_confirmations().request("budget.tokens", work_id, change)

    @server.tool(structured_output=True)
    async def sabre_increase_call_budget(work_id: str, change: CallBudgetIncrease) -> OwnerConfirmation:
        """Ask the owner to increase only max_calls on paused or blocked work that has no budget policy (effective_budget_policy is null); a run with a policy is refused here with VERSIONED_BUDGET_REQUIRED and takes sabre_amend_budget. Nothing changes until the owner confirms it in the SABRE console. Revision and previous limit must still match then. Usage, reservations and other limits remain unchanged; resume separately."""
        return await service().owner_confirmations().request("budget.calls", work_id, change)

    @server.tool(structured_output=True)
    async def sabre_use_cli_progress_limits(work_id: str, change: CliProgressLimitsChange) -> OwnerConfirmation:
        """Ask the owner to replace cumulative quotas with CLI progress controls on work that has no budget policy; a run with a policy is refused here with VERSIONED_BUDGET_REQUIRED. Nothing changes until the owner confirms it in the SABRE console. Preserves usage, requires the current plan and full budget, and does not resume the work."""
        return await service().owner_confirmations().request("budget.cli_progress", work_id, change)

    @server.tool(structured_output=True)
    async def sabre_amend_budget(work_id: str, request: BudgetAmendment) -> OwnerConfirmation:
        """Ask the owner to change one metric (tokens, invocations, active_seconds or repairs) of the run's budget policy; expected_revision is the run's budget_revision, and resume continues the run once applied. This is the tool for every run launched with a policy, which includes every run started from the console. Nothing changes until the owner confirms it in the SABRE console; the policy revision must still match then."""
        return await service().owner_confirmations().request("budget.amend", work_id, request)

    @server.tool(structured_output=True)
    async def sabre_reconcile_budget(work_id: str, request: BudgetReconciliation) -> OwnerConfirmation:
        """Ask the owner to reconcile uncertain model usage records. Nothing changes until the owner confirms it in the SABRE console."""
        return await service().owner_confirmations().request("budget.reconcile", work_id, request)

    @server.tool(structured_output=True)
    async def sabre_confirmations() -> OwnerConfirmationPage:
        """List requests waiting for the owner's confirmation in the console and the most recent decisions. Read-only."""
        return await service().owner_confirmations().list()

    @server.tool(structured_output=True)
    async def sabre_confirmation(confirmation_id: str) -> OwnerConfirmation:
        """Read one confirmation request: pending, applied, rejected, failed or expired. Read-only; an MCP client cannot decide it."""
        return await service().owner_confirmations().get(confirmation_id)

    @server.tool(structured_output=True)
    async def sabre_security_findings(project_id: str | None = None) -> list[dict]:
        """Read findings and recommendations from the independent security chain."""
        return await service().repository.security(project_id)

    @server.tool(structured_output=True)
    async def sabre_security_exceptions(work_id: str) -> list[SecurityException]:
        """List owner-approved, expiring security exceptions for this work order."""
        return [item for item in await service().repository.security_exceptions(work_id)]

    @server.tool(structured_output=True)
    async def sabre_approve_security_exception(work_id: str, request: SecurityExceptionCreate) -> OwnerConfirmation:
        """Ask the owner to accept the risk of an exact finding/snapshot/rules/revision, for at most 30 days. Nothing changes until the owner confirms it in the SABRE console. Secrets and scanner failures cannot be waived. Resume separately to review again."""
        return await service().owner_confirmations().request("security.exception", work_id, request)

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
        return (await service().memory.propose(request, proposed_by=ProposedBy(channel="owner_mcp")))

    @server.tool(structured_output=True)
    async def sabre_resolve_memory(memory_id: str, approve: bool) -> MemoryItem:
        """Approve or invalidate a memory as the authenticated owner."""
        return (await service().memory.update(memory_id, approve))

    @server.tool(structured_output=True)
    async def sabre_memory_graph(project_id: str, focus: Annotated[str | None, Field(pattern=MEMORY_ID_PATTERN)] = None,
                                 depth: Annotated[int, Field(ge=1, le=2)] = 1, limit: Annotated[int, Field(ge=1, le=300)] = 100) -> MemoryGraph:
        """Read a bounded graph of project memories with their runs, commits, cited files, proposers and links. Read-only."""
        return await service().memory.graph(project_id, focus, depth, limit)

    @server.tool(structured_output=True)
    async def sabre_memory_recalls(project_id: str, work_id: Annotated[str | None, Field(max_length=128)] = None,
                                   memory_id: Annotated[str | None, Field(pattern=MEMORY_ID_PATTERN)] = None,
                                   cursor: Annotated[str | None, Field(max_length=19)] = None,
                                   limit: Annotated[int, Field(ge=1, le=200)] = 50) -> MemoryRecallPage:
        """Read which memories each role call recalled, with ranks and sizes, and validator refusals. Read-only."""
        return await service().memory.recalls(project_id, work_id=work_id, memory_id=memory_id, cursor=cursor, limit=limit)

    @server.tool(structured_output=True)
    async def sabre_memory_review(project_id: str) -> MemoryReview:
        """Read pending memory proposals with their overlaps and stale project memories with changed files. Read-only; never approves."""
        return await service().memory.review(project_id)

    return server
