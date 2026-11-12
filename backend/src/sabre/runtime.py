import asyncio
from contextlib import AsyncExitStack, suppress

import procrastinate
from langgraph.checkpoint.postgres.aio import AsyncPostgresSaver
from psycopg.conninfo import conninfo_to_dict

from sabre.agents import AgentTeam
from sabre.artifacts import ArtifactStore
from sabre.credentials import Credentials
from sabre.embeddings import BudgetedEmbeddings
from sabre.error_boundaries import guarded_call
from sabre.executor import ExecutorClient
from sabre.integrations import IntegrationService
from sabre.mcp_connections import MCPConnectionStore
from sabre.memory import MemoryService
from sabre.model_configuration import ModelConfigurationService
from sabre.models import DomainError, SecurityFinding, Status, now
from sabre.project_tools import ProjectToolService
from sabre.publisher import GitHubPublisher
from sabre.repo_creation import RepoCreationService
from sabre.repository import Repository, digest
from sabre.repository_ingestion import RepositoryIngestion
from sabre.security import ScannerClient, SecretGuard, SecurityService
from sabre.service import FactoryService
from sabre.telemetry import configure, span
from sabre.vault import Vault
from sabre.workflows import Factory


class Runtime:
    def __init__(self, config):
        self.config = config
        self.stack = AsyncExitStack()
        self.ingestion: RepositoryIngestion | None = None

    async def __aenter__(self):
        try:
            return await self._start()
        except BaseException:
            await self.stack.aclose()
            raise

    async def _start(self):
        cfg = self.config
        # LangSmith may be installed transitively; no content tracing is enabled here.
        self.telemetry = configure(cfg.otlp_endpoint)
        if not cfg.vault_database_url.get_secret_value() or cfg.vault_master_key_file is None:
            raise DomainError("VAULT_NOT_CONFIGURED", "Configure the private bootstrap file and SABRE master key", 503)
        self.vault = Vault(cfg.vault_database_url.get_secret_value(), cfg.vault_master_key_file)
        await self.vault.initialize()
        self.repository = Repository(cfg.database_url.get_secret_value(), pool_size=max(8, cfg.execution_slots * 2 + 4), execution_slots=cfg.execution_slots)
        self.repository.notification_destinations = cfg.webhooks
        await self.repository.initialize()
        self.stack.push_async_callback(self.repository.close)
        checkpoint = await self.stack.enter_async_context(AsyncPostgresSaver.from_conn_string(cfg.database_url.get_secret_value()))
        async with self.repository.connection() as conn:
            await conn.execute("SELECT pg_advisory_xact_lock(813777)")
            await checkpoint.setup()
        self.checkpointer = checkpoint
        self.queue = procrastinate.App(connector=procrastinate.PsycopgConnector(conninfo=cfg.database_url.get_secret_value(), min_size=1, max_size=6))
        await self.queue.open_async()
        self.stack.push_async_callback(self.queue.close_async)
        async with self.repository.connection() as conn:
            await conn.execute("SELECT pg_advisory_xact_lock(813773)")
            row = await (await conn.execute("SELECT to_regclass('procrastinate_jobs') AS present")).fetchone()
            if not row["present"]:
                await self.queue.schema_manager.apply_schema_async()
        secrets = [s.get_secret_value() for s in (cfg.auth_token, cfg.executor_token, cfg.gateway_token, cfg.database_url, cfg.vault_database_url, cfg.model_api_key, cfg.github_token, cfg.slack_bot_token, cfg.slack_app_token) if s.get_secret_value()]
        secrets += [server.token.get_secret_value() for server in cfg.mcp_servers.values() if server.token.get_secret_value()]
        secrets += [role.model_api_key.get_secret_value() for role in cfg.role_models.values() if role.model_api_key and role.model_api_key.get_secret_value()]
        # Guard standalone database passwords too, not only their complete connection strings.
        secrets += [conninfo_to_dict(value.get_secret_value()).get("password", "") for value in (cfg.database_url, cfg.vault_database_url)]
        guard = SecretGuard(secrets)
        self.credentials = Credentials(self.vault, cfg, guard)
        self.model_configuration = ModelConfigurationService(self.repository, cfg, guard)
        self.credentials.model_configuration = self.model_configuration
        self.mcp_connections = MCPConnectionStore(self.repository, cfg, guard)
        self.credentials.mcp_connections = self.mcp_connections
        self.project_tools = ProjectToolService(self.repository, self.mcp_connections, guard)
        self.integrations = IntegrationService(self.repository, cfg, self.credentials, guard)
        self.credentials.integrations = self.integrations
        await self.credentials.refresh()
        executor = ExecutorClient(cfg.executor_url, cfg.executor_token.get_secret_value())
        artifacts = ArtifactStore(cfg.data_dir / "artifacts", guard)
        embeddings = BudgetedEmbeddings(self.repository, cfg, guard, credentials=self.credentials) if cfg.embedding_model else None
        memory = MemoryService(self.repository, guard, embeddings)
        team = AgentTeam(cfg, self.repository, executor, guard, checkpointer=checkpoint, credentials=self.credentials, artifacts=artifacts)
        async def security_analyst(work_id, findings):
            await self.credentials.refresh()
            work = await self.repository.work(work_id)
            if work.phase == "security_watch" or not cfg.for_role("security").model_ready() or any(f.category in {"secret", "scanner_error"} for f in findings):
                return []
            result = await team.run("security", work, await self.repository.project(work.project_id),
                "Independently review security of the actual source. Triage this scanner evidence, cite applicable files and propose remediations. "
                "Do not waive findings. Evidence: " + str([f.model_dump(mode="json") for f in findings]))
            await self.repository.event(work, "security_review", result.summary)
            if result.accepted:
                return []
            return [SecurityFinding(fingerprint=digest({"work": work.id, "review": result.summary}), scanner="agent_review", category="code", severity="high", title=result.summary[:1000])]

        security = SecurityService(ScannerClient(executor), checkpointer=checkpoint, analyst=security_analyst, guard=guard)
        publisher = GitHubPublisher(self.repository, "", token_resolver=lambda: self.credentials.resolve("github.publish"))
        self.factory = Factory(self.repository, team, executor, security, publisher, artifacts, guard, memory, checkpoint)

        @self.queue.task(name="sabre.process_work", queue="work", retry=3)
        async def process_work(work_id: str):
            with span("factory.work", work_id=work_id) as observation:
                try:
                    await self.credentials.refresh()
                    from sabre.delegation import authorize_delegated_work
                    await authorize_delegated_work(self.repository, await self.repository.work(work_id))
                    result = await self.factory.drive(work_id)
                    if result.status in {Status.BLOCKED, Status.FAILED}:
                        observation.outcome(DomainError(result.error_code or "EXECUTION_BLOCKED", ""))
                    return result.status.value
                except Exception as error:
                    work = await self.repository.work(work_id)
                    work.status, work.summary, work.error_code = Status.FAILED, "Execution failed; inspect controls and resume after correcting the cause", "EXECUTION_ERROR"
                    if isinstance(error, DomainError):
                        work.status, work.summary, work.error_code = Status.BLOCKED, error.message, error.code
                        work.budget_denial = error.budget_denial
                        if error.budget_denial:
                            work.limiting_metric = error.budget_denial.metric
                    await self.factory.finish(work)
                    await self.repository.event(work, "failed", work.summary)
                    # Do not persist exception strings: libraries can include request content or credentials.
                    raise RuntimeError("Factory execution failed") from None

        self.process = process_work

        @self.queue.task(name="sabre.create_repository", queue="maintenance", retry=3)
        async def create_repository(proposal_id: str):
            from sabre.create_flow import continue_create
            proposal = await self.repository_proposals.execute(proposal_id)
            await continue_create(self.service, proposal)
            return proposal.status

        async def enqueue_repository(conn, proposal_id):
            await create_repository.configure(connection=conn, lock=f"repository:{proposal_id}").defer_async(proposal_id=proposal_id)

        self.repository_proposals = RepoCreationService(self.repository, self.credentials, guard, enqueue=enqueue_repository)

        @self.queue.periodic(cron="* * * * *")
        @self.queue.task(name="sabre.recover_workers", queue="maintenance", queueing_lock="recover_workers")
        async def recover_workers(timestamp: int):
            for job in await self.queue.job_manager.get_stalled_jobs():
                await self.queue.job_manager.retry_job(job)

        @self.queue.periodic(cron="0 8 * * *")
        @self.queue.task(name="sabre.security_watch", queue="maintenance", queueing_lock="security_watch")
        async def security_watch(timestamp: int):
            from sabre.models import Budget, Task, WorkOrder
            for project in await self.repository.projects():
                work = WorkOrder(project_id=project.id, mode="maintain", objective="Security review scheduled",
                    acceptance=["Propose remediations; do not start patches"], budget=Budget(max_cost_usd=0.01),
                    idempotency_key=f"security:{project.id}:{timestamp}", phase="security_watch", created_at=now())
                # A watch run scans and reports only; it never enters the development graph.
                async def no_enqueue(conn, work_id):
                    return None
                work = await self.repository.admit(work, no_enqueue)
                try:
                    await self.credentials.refresh()
                    async with self.repository.project_lock(project.id) as acquired:
                        if not acquired:
                            raise DomainError("PROJECT_BUSY", "Security watch deferred: the repository or both execution slots are busy")
                        await executor.refresh_security_database()
                        await executor.prepare(project, work.id)
                        snapshot = await executor.snapshot(work.id)
                        report = await security.review(work.id, snapshot["digest"], project.approved_baseline, await self.repository.security_exceptions(work.id), plan_revision=work.plan_revision)
                        guard.check(report)
                        work.findings = report.findings
                        work.security_snapshot_digest, work.security_rules_version = report.snapshot_digest, report.rules_version
                        priorities = {"critical": 0, "high": 1, "medium": 2, "low": 3, "info": 4}
                        work.tasks = [Task(title=f"[{finding.severity}] {finding.title}"[:300], result=finding.remediation)
                            for finding in sorted(report.findings, key=lambda item: (priorities[item.severity], item.fingerprint))]
                        work.status = Status.BLOCKED if any(item.category == "scanner_error" for item in report.findings) else Status.COMPLETED
                        work.summary = f"Security watch finished: {len(work.tasks)} prioritized proposals. Select the work to commission; development has not started"
                        await self.repository.report_security(work)
                        await self.repository.save(work)
                        await self.repository.event(work, "security", work.summary)
                except DomainError as error:
                    work.status, work.error_code, work.summary = Status.BLOCKED, error.code, error.message
                    await self.repository.save(work)
                    await self.repository.event(work, "security_blocked", error.message)
                finally:
                    await executor.cleanup(work.id)

        from sabre.notifications import WebhookDelivery
        self.webhooks = WebhookDelivery(self.repository, cfg.webhooks, self.credentials)

        @self.queue.periodic(cron="* * * * *")
        @self.queue.task(name="sabre.notifications", queue="maintenance", queueing_lock="notifications")
        async def notifications(timestamp: int):
            from sabre.slack import deliver_notifications
            await self.credentials.refresh()
            await self.webhooks.deliver()
            await guarded_call(deliver_notifications, guard, "SLACK_DELIVERY_FAILED", self.repository, cfg, guard, credentials=self.credentials)

        self.service = FactoryService(self.repository, self.factory, memory, self, guard, cfg)
        from sabre.a2a import a2a_services
        self.a2a_connections, self.outbound_a2a = a2a_services(self.service)
        self.factory.team.outbound_a2a = self.outbound_a2a
        from sabre.browser_qa import BrowserQAService
        self.browser_qa = BrowserQAService(self.repository, executor, artifacts, guard)
        self.factory.team.browser_qa = self.browser_qa
        from sabre.slack import register_jobs
        await register_jobs(self)
        from sabre.operator_conversation import register_operator_job
        await register_operator_job(self)
        from sabre.repository_ingestion import register_ingestion_jobs
        await register_ingestion_jobs(self)
        self.factory.ingestion = self.ingestion
        return self

    async def __aexit__(self, exc_type, exc, tb):
        await self.stack.aclose()
        if self.telemetry:
            with suppress(Exception):
                await asyncio.to_thread(self.telemetry.shutdown)
