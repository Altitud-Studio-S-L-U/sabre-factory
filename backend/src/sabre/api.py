"""HTTP and MCP share the same application service and authorization boundary."""

import hmac
from contextlib import asynccontextmanager
from datetime import timedelta
from typing import Any

from fastapi import FastAPI, Query, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, RedirectResponse, Response
from pydantic.json_schema import models_json_schema

from sabre import __version__
from sabre.agent_contracts import (
    AgentCatalog,
    AgentCatalogEntry,
    AgentDraftSave,
    AgentMessage,
    AgentRevision,
    AgentValidation,
    StepResult,
)
from sabre.audit import AuditUsage, AuditView, ProjectKnowledgeReport, RunUsageSnapshot
from sabre.budget_contracts import BudgetAmendment, BudgetReconciliation, BudgetView
from sabre.commands import CommandEnvelope, CommandResult, dispatch
from sabre.create_flow import CreateFlowLaunch, launch_create
from sabre.events import EventPage
from sabre.flow_contracts import FlowConfiguration, FlowYamlRequest
from sabre.integrations import (
    GitHubRepositoryImport,
    GitHubRepositoryPage,
    GitHubRepositorySearch,
    IntegrationInfo,
    IntegrationStateChange,
)
from sabre.mcp_connections import MCPConnectionInfo, MCPConnectionSave, MCPDiscovery
from sabre.memory_contracts import MemoryApproval, MemoryCarryForward, MemoryGraph, MemoryValidityRecord
from sabre.model_configuration import ModelConfiguration, ModelConfigurationChange
from sabre.models import (
    MEMORY_ID_PATTERN,
    Answer,
    CallBudgetIncrease,
    CliProgressLimitsChange,
    DomainError,
    MemoryCreate,
    MemoryItem,
    Project,
    ProjectCreate,
    ProposedBy,
    ScopeChange,
    SecretDeactivate,
    SecretMetadata,
    SecretTarget,
    SecretUpsert,
    SecurityException,
    SecurityExceptionCreate,
    TokenBudgetIncrease,
    WorkOrder,
    WorkOrderCreate,
)
from sabre.notifications import DeliveryStatus
from sabre.operator_contracts import (
    OperatorMessagePage,
    OperatorMessageRequest,
    OperatorMessageResume,
    OperatorMessageView,
    OperatorToolTracePage,
)
from sabre.panel_sessions import (
    COOKIE,
    COOKIE_MAX_AGE,
    COOKIE_PATH,
    DEFAULT_ORIGIN,
    PanelSessions,
    TicketExchange,
    browser_context,
)
from sabre.project_tools import ProjectToolsChange, ProjectToolsPolicy
from sabre.repo_creation import (
    RepoCreationDecision,
    RepoCreationPage,
    RepoCreationProposal,
    RepoCreationRequest,
)
from sabre.system_info import SystemInfo
from sabre.web_routes import ConsoleFiles


class FactoryAPI(FastAPI):
    def openapi(self) -> dict[str, Any]:
        schema = super().openapi()
        _, exchange_schema = models_json_schema([(AgentMessage, "validation"), (StepResult, "validation")],
            ref_template="#/components/schemas/{model}")
        schema.setdefault("components", {}).setdefault("schemas", {}).update(exchange_schema.get("$defs", {}))
        return schema


_API_PREFIXES = ("/api/", "/mcp", "/internal/", "/delegated/", "/health")


def canonical_console_url(request: Request, allowed_origins) -> str | None:
    """Send console pages opened on localhost to 127.0.0.1.

    The paired-browser cookie belongs to the exact host it was set on, and the launcher pairs
    127.0.0.1. Without this, http://localhost:8000 shows the pairing screen to a paired browser.
    Only page navigations move; API, MCP and health requests are answered where they arrive.
    """
    if request.method not in {"GET", "HEAD"} or request.url.path.startswith(_API_PREFIXES):
        return None
    if request.url.hostname != "localhost":
        return None
    port = request.url.port
    target = f"http://127.0.0.1:{port}" if port else "http://127.0.0.1"
    if target not in (allowed_origins or []):
        return None
    query = f"?{request.url.query}" if request.url.query else ""
    return f"{target}{request.url.path}{query}"


def create_app(service=None, config=None) -> FastAPI:
    @asynccontextmanager
    async def lifespan(application):
        if service is not None:
            application.state.service, application.state.config = service, config
            yield
            return
        from sabre.runtime import Runtime
        from sabre.settings import settings
        cfg = settings()
        async with Runtime(cfg) as runtime:
            application.state.service, application.state.config = runtime.service, cfg
            if cfg.web_dir.is_dir():
                application.mount("/", ConsoleFiles(directory=cfg.web_dir, html=True), name="web")
            async with mcp_app.router.lifespan_context(mcp_app), delegated_app.router.lifespan_context(delegated_app):
                yield

    application = FactoryAPI(title="SABRE", version=__version__, lifespan=lifespan)
    application.state.service, application.state.config = service, config

    def panels():
        cfg = application.state.config
        return PanelSessions(svc().repository, cfg.auth_token.get_secret_value(), getattr(cfg, "panel_origin", DEFAULT_ORIGIN),
                             timedelta(days=getattr(cfg, "panel_session_days", 30)))

    async def authorize_request(request: Request, call_next):
        if request.url.path.startswith("/delegated/"):
            # Remote agents: a delegated grant only. Browsers have no place here, and the owner
            # credential is refused so it is never sent to a remote client.
            if request.headers.get("origin"):
                return JSONResponse({"code": "ORIGIN_DENIED", "message": "Origin not allowed"}, status_code=403)
            from sabre.delegation import Delegations
            await Delegations(svc()).authenticate(request.headers.get("authorization", ""))
            return await call_next(request)
        if request.url.path.startswith(("/api/", "/mcp", "/internal/")):
            cfg = application.state.config
            expected = cfg.auth_token.get_secret_value() if cfg else ""
            private = request.url.path.startswith("/internal/")
            if private:
                field = {"/internal/credentials/github-read": "executor_token", "/internal/credentials/slack": "gateway_token"}.get(request.url.path)
                value = getattr(cfg, field, None) if field else None
                expected = value.get_secret_value() if value else ""
            supplied = request.headers.get("authorization", "")
            authorized = bool(expected and hmac.compare_digest(supplied, "Bearer " + expected))
            if not private and request.url.path == "/api/v1/chat" and request.method == "POST":
                gateway = getattr(cfg, "gateway_token", None)
                authorized = authorized or bool(gateway and gateway.get_secret_value() and hmac.compare_digest(supplied, "Bearer " + gateway.get_secret_value()))
            browser = False
            if not private and request.url.path.startswith("/api/") and "authorization" not in request.headers:
                if request.url.path == "/api/v1/panel/session/exchange" and request.method == "POST":
                    browser_context(request, panels().origin, mutation=True)
                    authorized = browser = True
                elif request.url.path != "/api/v1/panel/session-ticket" and COOKIE in request.cookies:
                    request.state.panel_session = await panels().authenticate(request)
                    authorized = browser = True
            if not authorized:
                return JSONResponse({"code": "UNAUTHORIZED", "message": "Authenticate with the SABRE access credential"}, status_code=401)
            origin = request.headers.get("origin")
            if not browser and origin and origin not in cfg.allowed_origins:
                return JSONResponse({"code": "ORIGIN_DENIED", "message": "Origin not allowed"}, status_code=403)
        return await call_next(request)

    @application.middleware("http")
    async def authorize(request: Request, call_next):
        config = application.state.config
        canonical = canonical_console_url(request, getattr(config, "allowed_origins", None))
        if canonical:
            return RedirectResponse(canonical, status_code=308)
        try:
            response = await authorize_request(request, call_next)
        except DomainError as error:
            response = JSONResponse({"code": error.code, "message": error.message}, status_code=error.status_code)
        response.headers["Content-Security-Policy"] = "frame-ancestors 'none'"
        response.headers["X-Frame-Options"] = "DENY"
        response.headers["Referrer-Policy"] = "no-referrer"
        if request.url.path.startswith(("/api/", "/mcp", "/internal/", "/delegated/")):
            response.headers["Cache-Control"] = "no-store"
        return response

    @application.exception_handler(DomainError)
    async def domain_error(request, error):
        if request.url.path.startswith(("/api/v1/secrets", "/api/v1/secret-targets")):
            messages = {
                "SECRET_VERSION_CONFLICT": "The credential changed. Refresh state before trying again",
                "SECRET_NOT_CONFIGURED": "No credential is saved for this destination",
                "SECRET_ID_INVALID": "The credential destination is unsupported",
                "SECRET_VALUE_INVALID": "Review the credential value",
                "VAULT_MASTER_KEY_UNAVAILABLE": "The store key is unavailable to the SABRE control",
                "VAULT_MASTER_KEY_MISMATCH": "The control cannot open the store with the available key",
                "VAULT_INTEGRITY_ERROR": "The store requires an integrity review",
                "VAULT_NOT_INITIALIZED": "The credential store is not ready yet",
                "VAULT_UNAVAILABLE": "The credential store is unavailable",
            }
            code = error.code if error.code in messages else "SECRET_STORE_ERROR"
            return JSONResponse({"code": code, "message": messages.get(code, "Could not complete the credential store operation")}, status_code=error.status_code)
        return JSONResponse({"code": error.code, "message": error.message}, status_code=error.status_code)

    @application.exception_handler(RequestValidationError)
    async def validation_error(request, error):
        if request.url.path.startswith("/api/v1/panel/"):
            return JSONResponse({"code": "INVALID_REQUEST", "message": "The access link is invalid"}, status_code=422)
        # Pydantic's default response echoes invalid input, which can include secrets.
        if request.url.path.startswith(("/api/v1/secrets", "/api/v1/secret-targets")):
            return JSONResponse({"code": "INVALID_REQUEST", "message": "Review the credential destination, value and version"}, status_code=422)
        errors = [{"loc": e["loc"], "type": e["type"], "msg": e["msg"]} for e in error.errors()]
        return JSONResponse({"code": "INVALID_REQUEST", "message": "Review the request fields", "errors": errors}, status_code=422)

    def svc():
        current = application.state.service
        if current is None:
            raise DomainError("NOT_READY", "SABRE is still starting", 503)
        return current

    @application.get("/health")
    async def health():
        return {"status": "ok", "version": __version__}

    @application.post("/api/v1/panel/session-ticket", status_code=201, include_in_schema=False)
    async def panel_ticket():
        return await panels().issue()

    @application.post("/api/v1/panel/session/exchange", include_in_schema=False)
    async def panel_exchange(request: Request, body: TicketExchange):
        manager = panels()
        # Apply browser restrictions even when a caller also supplies a valid bearer.
        browser_context(request, manager.origin, mutation=True)
        session, payload = await manager.exchange(body.ticket.get_secret_value(), request.headers.get("user-agent", ""))
        response = JSONResponse(payload)
        # The server-side expiry slides with use and is the authority; the cookie only carries the capability.
        response.set_cookie(COOKIE, session, max_age=COOKIE_MAX_AGE, httponly=True, samesite="strict",
                            secure=manager.origin.startswith("https://"), path=COOKIE_PATH)
        return response

    @application.get("/api/v1/panel/session", include_in_schema=False)
    async def panel_session(request: Request):
        if not hasattr(request.state, "panel_session"):
            raise DomainError("PANEL_SESSION_REQUIRED", "Open SABRE from its local launcher", 401)
        return request.state.panel_session

    @application.get("/api/v1/panel/browsers", include_in_schema=False)
    async def paired_browsers(request: Request):
        if not hasattr(request.state, "panel_session"):
            raise DomainError("PANEL_SESSION_REQUIRED", "Open SABRE from its local launcher", 401)
        return {"browsers": await panels().paired(request), "lifetime_days": panels().lifetime // 86400}

    @application.delete("/api/v1/panel/browsers/{session_id}", status_code=204, include_in_schema=False)
    async def revoke_paired_browser(request: Request, session_id: str):
        if not hasattr(request.state, "panel_session"):
            raise DomainError("PANEL_SESSION_REQUIRED", "Open SABRE from its local launcher", 401)
        await panels().revoke_paired(session_id)
        return Response(status_code=204)

    @application.post("/api/v1/panel/session/logout", status_code=204, include_in_schema=False)
    async def panel_logout(request: Request):
        if not hasattr(request.state, "panel_session"):
            raise DomainError("PANEL_SESSION_REQUIRED", "Open SABRE from its local launcher", 401)
        await panels().revoke(request)
        response = Response(status_code=204)
        response.delete_cookie(COOKIE, path=COOKIE_PATH, httponly=True, samesite="strict",
                               secure=panels().origin.startswith("https://"))
        return response

    @application.post("/api/v1/commands", response_model=CommandResult)
    async def execute_command(body: CommandEnvelope):
        return await dispatch(svc(), body)

    @application.get("/api/v1/status")
    async def status():
        return await svc().status()

    @application.get("/api/v1/agents", response_model=AgentCatalog)
    async def agent_catalog():
        return await svc().agent_catalog().list()

    @application.get("/api/v1/agents/{agent_id}", response_model=AgentCatalogEntry)
    async def agent_definition(agent_id: str):
        return await svc().agent_catalog().get(agent_id)

    @application.put("/api/v1/agents/{agent_id}/draft", response_model=AgentCatalogEntry)
    async def save_agent_draft(agent_id: str, body: AgentDraftSave):
        return await svc().agent_catalog().change(agent_id, body)

    @application.post("/api/v1/agents/{agent_id}/validate", response_model=AgentValidation)
    async def validate_agent_draft(agent_id: str, body: AgentRevision):
        return await svc().agent_catalog().change(agent_id, body, validate=True)

    @application.post("/api/v1/agents/{agent_id}/publish", response_model=AgentCatalogEntry)
    async def publish_agent_draft(agent_id: str, body: AgentRevision):
        return await svc().agent_catalog().change(agent_id, body, publish=True)

    @application.get("/api/v1/model-configuration", response_model=ModelConfiguration)
    async def model_configuration():
        return await svc().get_model_configuration()

    @application.put("/api/v1/model-configuration", response_model=ModelConfiguration)
    async def change_model_configuration(body: ModelConfigurationChange):
        return await svc().change_model_configuration(body)

    @application.get("/api/v1/system", response_model=SystemInfo)
    async def system():
        return await svc().system_info()

    @application.get("/api/v1/integrations", response_model=list[IntegrationInfo])
    async def integrations():
        return await svc().integrations().list()

    @application.post("/api/v1/integrations/{integration_id}/state", response_model=IntegrationInfo)
    async def integration_state(integration_id: str, body: IntegrationStateChange):
        return await svc().integrations().change_state(integration_id, body)

    @application.get("/api/v1/mcp-connections", response_model=list[MCPConnectionInfo])
    async def mcp_connections():
        return await svc().mcp_connections().list()

    @application.put("/api/v1/mcp-connections/{name}", response_model=MCPConnectionInfo)
    async def save_mcp_connection(name: str, body: MCPConnectionSave):
        return await svc().save_mcp_connection(name, body)

    @application.post("/api/v1/mcp-connections/{name}/discover", response_model=MCPDiscovery)
    async def discover_mcp_connection(name: str, expected_revision: int):
        return await svc().mcp_connections().discover(name, expected_revision, svc()._credentials())

    @application.get("/api/v1/repository-proposals", response_model=RepoCreationPage)
    async def repository_proposals():
        return await svc().repository_proposals().list()

    @application.post("/api/v1/create-flows", response_model=RepoCreationProposal, status_code=202)
    async def create_repository_flow(body: CreateFlowLaunch):
        return await launch_create(svc(), body)

    @application.post("/api/v1/repository-proposals", response_model=RepoCreationProposal, status_code=201)
    async def propose_repository(body: RepoCreationRequest):
        return await svc().repository_proposals().propose(body)

    @application.get("/api/v1/repository-proposals/{proposal_id}", response_model=RepoCreationProposal)
    async def repository_proposal(proposal_id: str):
        return await svc().repository_proposals().get(proposal_id)

    @application.post("/api/v1/repository-proposals/{proposal_id}/decision", response_model=RepoCreationProposal)
    async def decide_repository(proposal_id: str, body: RepoCreationDecision):
        return await svc().repository_proposals().decide(proposal_id, body)

    @application.post("/api/v1/repository-proposals/{proposal_id}/reconcile", response_model=RepoCreationProposal)
    async def reconcile_repository(proposal_id: str):
        return await svc().repository_proposals().reconcile(proposal_id)

    @application.post("/api/v1/integrations/github/repositories/search", response_model=GitHubRepositoryPage)
    async def github_repositories(body: GitHubRepositorySearch):
        return await svc().integrations().github_repositories(body)

    @application.post("/api/v1/integrations/github/import", response_model=Project, status_code=201)
    async def github_import(body: GitHubRepositoryImport):
        request = await svc().integrations().github_import(body)
        return await svc().create_project(request)

    @application.post("/api/v1/chat", status_code=202)
    async def chat(body: dict):
        from sabre.error_boundaries import guarded_call
        from sabre.slack import admit_message
        return await guarded_call(admit_message, svc().guard, "SLACK_ADMISSION_FAILED", svc(), body)

    @application.get("/api/v1/operator/messages", response_model=OperatorMessagePage)
    async def operator_messages(work_id: str | None = None):
        return await svc().queue.operator_conversation.list(work_id)

    @application.post("/api/v1/operator/messages", response_model=OperatorMessageView, status_code=202)
    async def operator_message(body: OperatorMessageRequest):
        return await svc().queue.operator_conversation.admit(body)

    @application.get("/api/v1/operator/messages/{message_id}/tools", response_model=OperatorToolTracePage)
    async def operator_message_tools(message_id: str):
        from sabre.operator_inspection import inspect_operator_tools
        return await inspect_operator_tools(svc(), message_id)

    from sabre.operator_readiness import FactoryReadinessView, factory_readiness

    @application.get("/api/v1/operator/readiness", response_model=FactoryReadinessView)
    async def operator_readiness():
        return await factory_readiness(svc())

    @application.post("/api/v1/operator/messages/{message_id}/resume", response_model=OperatorMessageView, status_code=202)
    async def resume_operator_message(message_id: str, body: OperatorMessageResume):
        return await svc().queue.operator_conversation.resume(message_id, body)

    @application.get("/internal/credentials/github-read", include_in_schema=False)
    async def github_read_credentials():
        return JSONResponse(await svc().private_credentials("github-read"), headers={"Cache-Control": "no-store"})

    @application.get("/internal/credentials/slack", include_in_schema=False)
    async def slack_credentials():
        return JSONResponse(await svc().private_credentials("slack"), headers={"Cache-Control": "no-store"})

    @application.get("/api/v1/projects", response_model=list[Project])
    async def projects():
        return await svc().repository.projects()

    @application.post("/api/v1/projects", response_model=Project, status_code=201)
    async def create_project(body: ProjectCreate):
        return await svc().create_project(body)

    @application.get("/api/v1/projects/{project_id}/mcp-tools", response_model=ProjectToolsPolicy)
    async def project_tools(project_id: str):
        return await svc().project_tools().get(project_id)

    @application.put("/api/v1/projects/{project_id}/mcp-tools", response_model=ProjectToolsPolicy)
    async def change_project_tools(project_id: str, body: ProjectToolsChange):
        return await svc().project_tools().change(project_id, body)

    @application.get("/api/v1/notifications", response_model=list[DeliveryStatus])
    async def notification_statuses():
        return await svc().queue.webhooks.statuses()

    @application.post("/api/v1/notifications/{delivery_id}/retry", response_model=list[DeliveryStatus])
    async def retry_notification(delivery_id: str):
        return await svc().queue.webhooks.retry(delivery_id)

    @application.get("/api/v1/flows/schema")
    async def flow_configuration_schema():
        from sabre.flows import flow_schema
        return flow_schema()

    @application.post("/api/v1/flows/parse", response_model=FlowConfiguration)
    async def parse_flow(body: FlowYamlRequest):
        from sabre.flows import parse_flow_yaml
        return parse_flow_yaml(body.document)

    @application.get("/api/v1/work/{work_id}/execution-events", response_model=EventPage)
    async def execution_events(work_id: str, after: int = 0, limit: int = 100):
        await svc().repository.work(work_id)
        return await svc().repository.execution_events(work_id, after, limit)

    @application.get("/api/v1/work", response_model=list[WorkOrder])
    async def works():
        return await svc().repository.works()

    @application.post("/api/v1/work", response_model=WorkOrder, status_code=202)
    async def submit(body: WorkOrderCreate):
        return await svc().submit(body)

    @application.get("/api/v1/work/{work_id}", response_model=WorkOrder)
    async def work(work_id: str):
        return await svc().repository.work(work_id)

    @application.get("/api/v1/work/{work_id}/usage", response_model=RunUsageSnapshot)
    async def work_usage(work_id: str):
        repository = svc().repository
        work = await repository.work(work_id)
        current = await repository.audit_usage_breakdown(work.id)
        return RunUsageSnapshot(work_id=work.id, usage=AuditUsage(**current["usage"]),
            measured_api_cost_usd=current["measured_api_cost_usd"], reserved_api_cost_usd=current["reserved_api_cost_usd"])

    @application.get("/api/v1/work/{work_id}/budget", response_model=BudgetView)
    async def work_budget(work_id: str):
        from sabre.budget_views import budget_view
        return await budget_view(svc().repository, work_id)

    @application.post("/api/v1/work/{work_id}/budget/amend", response_model=WorkOrder)
    async def amend_work_budget(work_id: str, body: BudgetAmendment):
        return await svc().amend_budget(work_id, body)

    @application.post("/api/v1/work/{work_id}/budget/reconcile", response_model=WorkOrder)
    async def reconcile_work_budget(work_id: str, body: BudgetReconciliation):
        return await svc().reconcile_budget_usage(work_id, body)

    @application.post("/api/v1/work/{work_id}/answer", response_model=WorkOrder)
    async def answer(work_id: str, body: Answer):
        return await svc().answer(work_id, body)

    @application.post("/api/v1/work/{work_id}/pause", response_model=WorkOrder)
    async def pause(work_id: str):
        return await svc().control(work_id, "pause")

    @application.post("/api/v1/work/{work_id}/resume", response_model=WorkOrder)
    async def resume(work_id: str):
        return await svc().control(work_id, "resume")

    @application.post("/api/v1/work/{work_id}/cancel", response_model=WorkOrder)
    async def cancel(work_id: str):
        return await svc().control(work_id, "cancel")

    @application.post("/api/v1/work/{work_id}/scope", response_model=WorkOrder)
    async def scope(work_id: str, body: ScopeChange):
        return await svc().change_scope(work_id, body)

    @application.post("/api/v1/work/{work_id}/budget/tokens", response_model=WorkOrder)
    async def increase_token_budget(work_id: str, body: TokenBudgetIncrease):
        return await svc().increase_token_budget(work_id, body)

    @application.post("/api/v1/work/{work_id}/budget/calls", response_model=WorkOrder)
    async def increase_call_budget(work_id: str, body: CallBudgetIncrease):
        return await svc().increase_call_budget(work_id, body)

    @application.post("/api/v1/work/{work_id}/cli-progress-limits", response_model=WorkOrder)
    async def use_cli_progress_limits(work_id: str, body: CliProgressLimitsChange):
        return await svc().use_cli_progress_limits(work_id, body)

    @application.get("/api/v1/work/{work_id}/events")
    async def events(work_id: str):
        await svc().repository.work(work_id)
        return await svc().repository.events(work_id)

    @application.get("/api/v1/work/{work_id}/audit", response_model=AuditView)
    async def work_audit(work_id: str):
        return await svc().audit_service().audit(work_id)

    @application.get("/api/v1/projects/{project_id}/knowledge", response_model=ProjectKnowledgeReport)
    async def project_knowledge(project_id: str):
        return await svc().audit_service().knowledge(project_id)

    @application.get("/api/v1/memory", response_model=list[MemoryItem])
    async def memories(project_id: str):
        await svc().repository.project(project_id)
        return await svc().repository.memories(project_id)

    @application.post("/api/v1/memory", response_model=MemoryItem, status_code=201)
    async def propose_memory(body: MemoryCreate):
        return await svc().memory.propose(body, proposed_by=ProposedBy(channel="owner_console"))

    @application.get("/api/v1/memory/search")
    async def memory_search(project_id: str, query: str, commit: str):
        return await svc().memory.search(project_id, query, commit)

    @application.post("/api/v1/memory/{memory_id}/approve", response_model=MemoryItem)
    async def approve_memory(memory_id: str, body: MemoryApproval | None = None):
        return await svc().memory.update(memory_id, True, body)

    @application.post("/api/v1/memory/{memory_id}/carry-forward", response_model=MemoryValidityRecord)
    async def carry_memory_forward(memory_id: str, body: MemoryCarryForward):
        return await svc().memory.carry_forward(memory_id, body)

    @application.post("/api/v1/memory/{memory_id}/invalidate", response_model=MemoryItem)
    async def invalidate_memory(memory_id: str):
        return await svc().memory.update(memory_id, False)

    @application.get("/api/v1/projects/{project_id}/memory/graph", response_model=MemoryGraph)
    async def memory_graph(project_id: str, focus: str | None = Query(default=None, pattern=MEMORY_ID_PATTERN),
                           depth: int = Query(default=1, ge=1, le=2), limit: int = Query(default=100, ge=1, le=300)):
        return await svc().memory.graph(project_id, focus, depth, limit)

    @application.get("/api/v1/secret-targets", response_model=list[SecretTarget])
    async def secret_targets():
        return await svc().secret_targets()

    @application.get("/api/v1/secrets", response_model=list[SecretMetadata])
    async def secrets():
        return await svc().list_secrets()

    @application.post("/api/v1/secrets/{secret_id}", response_model=SecretMetadata)
    async def upsert_secret(secret_id: str, body: SecretUpsert):
        return await svc().upsert_secret(secret_id, body)

    @application.post("/api/v1/secrets/{secret_id}/deactivate", response_model=SecretMetadata)
    async def deactivate_secret(secret_id: str, body: SecretDeactivate):
        return await svc().deactivate_secret(secret_id, body.expected_version)

    @application.get("/api/v1/security")
    async def security(project_id: str | None = None):
        return await svc().repository.security(project_id)

    @application.get("/api/v1/work/{work_id}/security-exceptions", response_model=list[SecurityException])
    async def security_exceptions(work_id: str):
        return await svc().repository.security_exceptions(work_id)

    @application.post("/api/v1/work/{work_id}/security-exceptions", response_model=SecurityException, status_code=201)
    async def approve_security_exception(work_id: str, body: SecurityExceptionCreate):
        return await svc().approve_security_exception(work_id, body)

    @application.post("/api/v1/work/{work_id}/security-exceptions/{exception_id}/revoke", response_model=SecurityException)
    async def revoke_security_exception(work_id: str, exception_id: str):
        return await svc().revoke_security_exception(work_id, exception_id)

    from sabre.mcp_server import build_mcp
    mcp = build_mcp(svc)
    mcp_app = mcp.streamable_http_app(streamable_http_path="/")
    application.mount("/mcp", mcp_app)
    application.state.mcp = mcp
    from sabre.mcp_delegated import build_delegated_mcp
    delegated_mcp = build_delegated_mcp(svc)
    delegated_app = delegated_mcp.streamable_http_app(streamable_http_path="/")
    application.mount("/delegated/mcp", delegated_app)
    application.state.delegated_mcp = delegated_mcp
    from sabre.a2a import install_a2a
    from sabre.browser_qa import install_browser_routes
    from sabre.console_configuration import install_console_routes
    from sabre.inspection import install_inspection_routes
    from sabre.release_candidates import install_release_routes
    from sabre.repository_ingestion import install_ingestion_routes
    install_a2a(application, svc)
    install_browser_routes(application, svc)
    install_console_routes(application, svc)
    install_inspection_routes(application, svc)
    install_ingestion_routes(application, svc)
    install_release_routes(application, svc)
    return application


app = create_app()
