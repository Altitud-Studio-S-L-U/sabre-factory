import asyncio

from pydantic import SecretStr

from sabre import __version__
from sabre.models import (
    Answer,
    CallBudgetIncrease,
    CliProgressLimitsChange,
    DomainError,
    Project,
    ProjectCreate,
    ScopeChange,
    SecurityExceptionCreate,
    Status,
    TokenBudgetIncrease,
    WorkOrder,
    WorkOrderCreate,
)
from sabre.publisher import github_repository


class FactoryService:
    def __init__(self, repository, factory, memory, queue, guard, config):
        self.repository, self.factory, self.memory = repository, factory, memory
        self.queue, self.guard, self.config = queue, guard, config

    def agent_catalog(self):
        from sabre.agent_catalog import AgentCatalogService
        return AgentCatalogService(self.repository, self.guard)

    async def create_project(self, request: ProjectCreate):
        self.guard.check(request.model_dump())
        repository = github_repository(request.repository)
        request = request.model_copy(update={"repository": f"https://github.com/{repository}"})
        if any(p.repository.casefold() == request.repository.casefold() for p in await self.repository.projects()):
            raise DomainError("PROJECT_EXISTS", "This repository is already registered")
        return await self.repository.create_project(Project(**request.model_dump()),
                                                    enqueue=getattr(self.queue, "enqueue_ingestion", None))

    async def enqueue(self, conn, work_id):
        row = await (await conn.execute("SELECT project_id FROM work_orders WHERE id=%s", (work_id,))).fetchone()
        await self.queue.process.configure(connection=conn, lock=f"project:{row['project_id']}").defer_async(work_id=work_id)

    async def submit(self, request: WorkOrderCreate):
        self.guard.check(request.model_dump())
        from sabre.repository import digest
        if hasattr(self.repository, "reconcile_admission"):
            prior = await self.repository.reconcile_admission(request)
            if prior is not None:
                return prior
        if request.budget.progress_limits and not getattr(self.queue, "model_configuration", None):
            await self._cli_progress_selection()
        await self.repository.project(request.project_id)
        work = WorkOrder(**request.model_dump())
        work.admission_request_digest = digest(request.model_dump(mode="json"))
        if getattr(self.queue, 'model_configuration', None):
            from sabre.console_configuration import pinned_models, prepare_run_configuration
            definitions = None
            durable_launch = hasattr(self.repository, "connection") and hasattr(self.queue.model_configuration, "snapshot")
            if durable_launch:
                work, request = await prepare_run_configuration(self, work, request)
                definitions = await self.agent_catalog().published()
            policy = request.budget.policy or request.flow_config.budget_policy
            if policy is None and durable_launch:
                from sabre.budget_contracts import legacy_policy
                policy = legacy_policy(request.budget, request.flow_config.repair_cycles)
            if policy is not None:
                work.budget.policy = policy.model_copy(deep=True)
                work.effective_budget_policy = policy.model_copy(deep=True)
            from sabre.flows import resolve_flow
            work.resolved_flow = await resolve_flow(request.flow_config, request.mode,
                self.queue.model_configuration, self.queue.credentials, definitions, pinned_models(work))
            if request.budget.progress_limits:
                if any(item.model.provider not in {'codex_cli', 'claude_cli'} for item in work.resolved_flow.phases.values()):
                    raise DomainError('MODEL_LIMITS_REQUIRED', 'API phases require explicit cumulative limits', 422)
        if work.resolved_flow:
            await self.preflight(work)
        return await self.repository.admit(work, self.enqueue)

    async def amend_budget(self, work_id, request):
        self.guard.check(request)
        async with self.repository.project_lock((await self.repository.work(work_id)).project_id, execution_slot=False) as acquired:
            if not acquired:
                raise DomainError("PROJECT_BUSY", "Wait for the run to reach a safe point before changing its budget", 409)
            if request.resume and await self.repository.unreconciled_usage(work_id):
                raise DomainError("USAGE_RECONCILIATION_REQUIRED", "Reconcile uncertain model usage before resuming", 409)
            work = await self.repository.amend_budget(work_id, request)
            if request.resume:
                return await self.repository.resume(work_id, self.enqueue)
            return work

    async def reconcile_budget_usage(self, work_id, request):
        self.guard.check(request)
        async with self.repository.project_lock((await self.repository.work(work_id)).project_id, execution_slot=False) as acquired:
            if not acquired:
                raise DomainError("PROJECT_BUSY", "Wait for the pending execution to stop before reconciling usage", 409)
            return await self.repository.reconcile_budget_usage(work_id, request)

    async def preflight(self, work, project=None):
        project = project or await self.repository.project(work.project_id)
        if not project.gate_commands:
            raise DomainError("VERIFICATION_REQUIRED", "Register executable verification commands before launching", 422)
        providers = {phase.model.provider for phase in work.resolved_flow.phases.values()}
        for provider in providers & {"codex_cli", "claude_cli"}:
            runner = await self._runner_status(provider)
            if not runner.get("available") or runner.get("authenticated") is not True:
                raise DomainError("MODEL_SESSION_UNAVAILABLE", "Connect an available CLI session before launching this flow", 409)
        for phase in work.resolved_flow.phases.values():
            if phase.model.provider in {"codex_cli", "claude_cli", "local"}:
                continue
            if work.budget.max_cost_usd <= 0:
                raise DomainError("API_BUDGET_REQUIRED", "Authorize an API spending limit before launching API phases", 422)
            if self.config.monthly_budget_usd <= 0 or phase.model.input_usd_per_million <= 0 or phase.model.output_usd_per_million <= 0:
                raise DomainError("MODEL_PRICING_REQUIRED", "Set provider prices and a monthly budget before launching API phases", 422)
            key = await self.queue.credentials.resolve(phase.credential_target)
            if not key.get_secret_value():
                raise DomainError("MODEL_CREDENTIAL_MISSING", "Configure the selected API credential before launching", 409)

    async def answer(self, work_id: str, request: Answer):
        self.guard.check(request.model_dump())
        await self.repository.answer(work_id, request.model_dump(), self.enqueue)
        return await self.repository.work(work_id)

    async def control(self, work_id: str, command: str):
        work = await self.repository.work(work_id)
        if work.phase == "security_watch":
            raise DomainError("WATCH_REPORT", "Security watch produces a report; create a new work order to remediate its proposals")
        if command not in {"pause", "resume", "cancel"}:
            raise DomainError("INVALID_COMMAND", "Use pause, resume or cancel", 422)
        if work.status in {Status.COMPLETED, Status.CANCELLED}:
            raise DomainError("WORK_TERMINAL", "The work order has already finished")
        if command == "resume":
            async with self.repository.project_lock(work.project_id, execution_slot=False) as acquired:
                if not acquired:
                    raise DomainError("PROJECT_BUSY", "Wait for the run to reach its pause point")
                if work.effective_budget_policy is not None and await self.repository.unreconciled_usage(work_id):
                    raise DomainError("USAGE_RECONCILIATION_REQUIRED", "Retain or reconcile the unsettled model reservations before resuming", 409)
                return await self.repository.resume(work_id, self.enqueue)
        await self.repository.request_control(work_id, command)
        if command == "cancel" and hasattr(self.factory.executor, "cancel_browser_jobs"):
            await self.factory.executor.cancel_browser_jobs(work_id)
        if command == "cancel" and getattr(self.queue, "outbound_a2a", None) is not None:
            try:
                async with asyncio.timeout(35):
                    await self.queue.outbound_a2a.cancel_work(work_id)
            except TimeoutError:
                await self.repository.event(work, "external_cancel_uncertain", "Remote cancellation requires reconciliation")
        async with self.repository.project_lock(work.project_id, execution_slot=False) as acquired:
            if acquired:
                applied = await self.repository.finalize_idle_control(work_id, command)
                if applied and command == "cancel":
                    await self.factory.executor.cleanup(work_id)
        return await self.repository.work(work_id)

    async def change_scope(self, work_id: str, change: ScopeChange):
        self.guard.check(change.model_dump())
        work = await self.repository.work(work_id)
        if work.phase == "security_watch":
            raise DomainError("WATCH_REPORT", "Create a new work order from security watch proposals")
        if work.status not in {Status.PAUSED, Status.BLOCKED}:
            raise DomainError("PAUSE_REQUIRED", "Pause the work order before changing its scope")
        if work.plan_revision != change.expected_revision:
            raise DomainError("STALE_PLAN", "The plan changed")
        async with self.repository.project_lock(work.project_id, execution_slot=False) as acquired:
            if not acquired:
                raise DomainError("PROJECT_BUSY", "Wait for the run to reach its pause point")
            return await self.repository.revise_scope(work_id, change)

    async def increase_token_budget(self, work_id: str, change: TokenBudgetIncrease):
        self.guard.check(change.model_dump())
        work = await self.repository.work(work_id)
        if work.phase == "security_watch":
            raise DomainError("WATCH_REPORT", "Security watch produces a report; create a new work order to remediate its proposals")
        async with self.repository.project_lock(work.project_id, execution_slot=False) as acquired:
            if not acquired:
                raise DomainError("PROJECT_BUSY", "Wait for the run to reach its pause point")
            return await self.repository.increase_token_budget(work_id, change)

    async def increase_call_budget(self, work_id: str, change: CallBudgetIncrease):
        self.guard.check(change.model_dump())
        work = await self.repository.work(work_id)
        if work.phase == "security_watch":
            raise DomainError("WATCH_REPORT", "Security watch produces a report; create a new work order to remediate its proposals")
        async with self.repository.project_lock(work.project_id, execution_slot=False) as acquired:
            if not acquired:
                raise DomainError("PROJECT_BUSY", "Wait for the run to reach its pause point")
            return await self.repository.increase_call_budget(work_id, change)

    async def _cli_progress_selection(self) -> int:
        selection = await self.model_configuration().get()
        providers = {selection.default.provider, *(role.effective.provider for role in selection.roles)}
        if not providers <= {"codex_cli", "claude_cli"}:
            raise DomainError("MODEL_LIMITS_REQUIRED", "Select CLI sessions for the default model and all roles, or retain explicit quotas", 409)
        return selection.revision

    async def use_cli_progress_limits(self, work_id: str, change: CliProgressLimitsChange):
        self.guard.check(change.model_dump())
        work = await self.repository.work(work_id)
        if work.phase == "security_watch":
            raise DomainError("WATCH_REPORT", "Security watch produces a report; create a new work order to remediate its proposals")
        async with self.repository.project_lock(work.project_id, execution_slot=False) as acquired:
            if not acquired:
                raise DomainError("PROJECT_BUSY", "Wait for the run to reach its pause point")
            revision = await self._cli_progress_selection()
            return await self.repository.use_cli_progress_limits(work_id, change, revision)

    async def approve_security_exception(self, work_id: str, request: SecurityExceptionCreate):
        self.guard.check(request)
        work = await self.repository.work(work_id)
        if work.phase == "security_watch":
            raise DomainError("WATCH_REPORT", "Commission remediation; a security watch review does not deliver code")
        async with self.repository.project_lock(work.project_id, execution_slot=False) as acquired:
            if not acquired:
                raise DomainError("PROJECT_BUSY", "Wait for the run to reach its pause point")
            work = await self.repository.work(work_id)
            snapshot = await self.factory.executor.snapshot(work_id)
            if snapshot["digest"] != request.snapshot_digest or await self.factory.executor.security_version(work_id) != request.rules_version:
                raise DomainError("STALE_SECURITY", "The code or policy no longer matches the proposed exception")
            approved = await self.repository.create_security_exception(work_id, request)
            work.evidence = None
            await self.factory.graph.aupdate_state(self.factory.config(work_id), {"order": work.model_dump(mode="json")}, as_node="review")
            await self.repository.save(work)
            await self.repository.event(work, "security_exception", "Exception approved by the owner; resume to review against the current policy")
            return approved

    async def revoke_security_exception(self, work_id: str, exception_id: str):
        work = await self.repository.work(work_id)
        async with self.repository.project_lock(work.project_id, execution_slot=False) as acquired:
            if not acquired:
                raise DomainError("PROJECT_BUSY", "Pause the work order and wait for the next safe point before revoking")
            revoked = await self.repository.revoke_security_exception(work_id, exception_id)
            work = await self.repository.work(work_id)
            if work.status in {Status.BLOCKED, Status.PAUSED}:
                work.evidence = None
                await self.factory.graph.aupdate_state(self.factory.config(work_id), {"order": work.model_dump(mode="json")}, as_node="review")
                await self.repository.save(work)
            await self.repository.event(work, "security_exception_revoked", "The owner revoked a security exception")
            return revoked

    async def status(self):
        if getattr(self.queue, "credentials", None):
            await self.queue.credentials.refresh()
        roles = {role: {"configured": self.config.for_role(role).model_ready(), "provider": self.config.for_role(role).model_provider, "name": self.config.for_role(role).model_name} for role in ("supervisor", "analyst", "architect", "developer", "qa", "reviewer", "security")}
        runners = {}
        for provider in {self.config.model_provider, *(role["provider"] for role in roles.values())} & {"codex_cli", "claude_cli"}:
            runners[provider] = await self._runner_status(provider)
            for role in roles.values():
                if role["provider"] == provider:
                    role["configured"] = runners[provider]["authenticated"] is True
        cli = runners.get(self.config.model_provider)
        return {
            "version": __version__, "graph_version": "sabre-v1", "database": "connected" if await self.repository.healthy() else "unavailable",
            "model": {"configured": cli["authenticated"] is True if cli else self.config.model_ready(), "provider": self.config.model_provider, "name": self.config.model_name, "cli": cli},
            "runners": runners,
            "roles": roles,
            "github": {"configured": bool(self.config.github_token.get_secret_value())},
            "slack": {"configured": bool(self.config.slack_bot_token.get_secret_value() and self.config.slack_owner_id)},
            "memory": {"store": "postgres-pgvector", "semantic_search": bool(self.config.embedding_model)},
            "security": {"chain": "independent", "scanner_failure": "blocking"},
            "telemetry": {"configured": bool(self.config.otlp_endpoint)},
            "monthly_budget_usd": self.config.monthly_budget_usd,
            "limits": {"concurrent_work": self.config.execution_slots, "writers_per_repository": 1, "repair_cycles": 2},
        }

    async def _runner_status(self, provider):
        if provider == "codex_cli":
            from sabre.codex_model import runner_status
        else:
            from sabre.claude_model import runner_status
        try:
            result = await runner_status(self.config)
            if result.get("busy"):
                result = {**result, "authenticated": None}
            return result
        except DomainError as error:
            return {"available": False, "authenticated": None, "busy": False, "error_code": error.code}

    def model_configuration(self):
        value = getattr(self.queue, "model_configuration", None)
        if value is None:
            raise DomainError("MODEL_CONFIGURATION_UNAVAILABLE", "Model configuration is unavailable", 503)
        return value

    async def get_model_configuration(self):
        result = await self.model_configuration().get()
        return await self._model_runner_statuses(result)

    async def _model_runner_statuses(self, result):
        from sabre.model_configuration import ModelRunnerStatus
        for provider in ("codex_cli", "claude_cli"):
            status = await self._runner_status(provider)
            result.runners.append(ModelRunnerStatus(provider=provider,
                **{key: status[key] for key in ("available", "authenticated", "busy", "error_code") if key in status}))
        return result

    async def change_model_configuration(self, request):
        result = await self.model_configuration().change(request)
        await self._credentials().refresh()
        return await self._model_runner_statuses(result)

    def _credentials(self):
        credentials = getattr(self.queue, "credentials", None)
        if credentials is None:
            raise DomainError("VAULT_UNAVAILABLE", "The credential vault is unavailable", 503)
        return credentials

    def integrations(self):
        integrations = getattr(self.queue, "integrations", None)
        if integrations is None:
            raise DomainError("INTEGRATIONS_UNAVAILABLE", "The integration catalog is unavailable", 503)
        return integrations

    def audit_service(self):
        from sabre.audit import AuditService
        return AuditService(self.repository, self.factory.team.checkpointer, self.guard,
                            semantic_search=bool(self.config.embedding_model))

    def mcp_connections(self):
        value = getattr(self.queue, "mcp_connections", None)
        if value is None:
            raise DomainError("MCP_REGISTRY_UNAVAILABLE", "The MCP registry is unavailable", 503)
        return value

    async def save_mcp_connection(self, name, request):
        result = await self.mcp_connections().save(name, request)
        await self._credentials().refresh()
        return result

    def repository_proposals(self):
        value = getattr(self.queue, "repository_proposals", None)
        if value is None:
            raise DomainError("REPOSITORY_QUEUE_UNAVAILABLE", "Repository creation is unavailable", 503)
        return value

    def project_tools(self):
        value = getattr(self.queue, "project_tools", None)
        if value is None:
            raise DomainError("MCP_REGISTRY_UNAVAILABLE", "MCP permissions are unavailable", 503)
        return value

    async def system_info(self):
        from sabre.system_info import system_info
        return await system_info(self)

    async def list_secrets(self):
        return await self._credentials().vault.list_metadata()

    async def secret_targets(self):
        credentials = self._credentials()
        await credentials.refresh()
        return credentials.target_list()

    async def upsert_secret(self, identifier, request):
        credentials = self._credentials()
        await credentials.refresh()
        credentials.validate_target(identifier)
        result = await credentials.vault.put(identifier, request)
        await credentials.refresh()
        return result

    async def deactivate_secret(self, identifier, expected_version):
        credentials = self._credentials()
        # Stored destinations remain removable after public configuration changes.
        result = await credentials.vault.deactivate(identifier, expected_version)
        await credentials.refresh()
        return result

    async def private_credentials(self, purpose):
        credentials = self._credentials()
        if purpose == "github-read":
            return {"token": (await credentials.resolve("github.read")).get_secret_value()}
        if purpose == "slack":
            await credentials.refresh()
            return {"bot_token": credentials.values.get("slack.bot", SecretStr("")).get_secret_value(),
                    "app_token": credentials.values.get("slack.app", SecretStr("")).get_secret_value()}
        raise DomainError("FORBIDDEN", "Unauthorized", 403)
