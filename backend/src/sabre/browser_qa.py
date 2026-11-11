"""Disposable preview/browser pairs and durable, source-bound QA evidence."""

import asyncio
import base64
import hashlib
import io
import json
import threading
import time
from pathlib import Path

import docker

from sabre.browser_contracts import BrowserEvidence, BrowserJob, BrowserPreview, BrowserReport
from sabre.models import DomainError
from sabre.repository import digest

MAX_RESULT = 40_000_000
SECCOMP_DIGEST = "7ccb7b4fdd100c367beaebe91504dd12b39b8f0c702dff7255b460b5e255e09c"
CONTAINER_TEMP = "/tmp"  # noqa: S108 - private bounded tmpfs in disposable jobs


def browser_seccomp():
    profile = Path(__file__).with_name("browser_seccomp.json").read_bytes()
    if hashlib.sha256(profile).hexdigest() != SECCOMP_DIGEST:
        raise DomainError("BROWSER_SANDBOX_POLICY_CHANGED", "The reviewed Chromium sandbox policy changed", 503)
    return profile.decode()


class BrowserRunner:
    def __init__(self, broker):
        self.broker = broker
        self.running: dict[str, threading.Event] = {}

    def cancel(self, work_id):
        event = self.running.get(work_id)
        if event:
            event.set()

    def cleanup_orphans(self, work_id):
        for kind, accessor in (("container", self.broker.docker.containers), ("network", self.broker.docker.networks)):
            resources = accessor.list(**({"all": True} if kind == "container" else {}),
                filters={"label": ["sabre.owner=factory", f"sabre.work_id={work_id}", "sabre.kind=browser-qa"]})
            for resource in resources:
                labels = (resource.attrs.get("Config", {}).get("Labels") if kind == "container" else resource.attrs.get("Labels")) or {}
                if labels.get("sabre.owner") != "factory" or labels.get("sabre.work_id") != work_id or labels.get("sabre.kind") != "browser-qa":
                    raise DomainError("BROWSER_RESOURCE_OWNERSHIP", "The browser resource does not belong to this run")
                resource.remove(**({"force": True} if kind == "container" else {}))

    def _execute(self, work_id, job, metadata, cancel):
        preview_policy = BrowserPreview.model_validate(metadata["project"]["browser_preview"], strict=True)
        image = self.broker._image("SABRE_BROWSER_IMAGE")
        # Probe image availability before allocating networks or running project code.
        try:
            self.broker.docker.images.get(image)
        except docker.errors.ImageNotFound:
            raise DomainError("BROWSER_CAPABILITY_UNAVAILABLE", "Build the pinned browser runner before running browser QA", 503) from None
        self.cleanup_orphans(work_id)
        key = digest({"work": work_id, "job": job.model_dump(mode="json")})
        labels = {"sabre.owner": "factory", "sabre.work_id": work_id, "sabre.kind": "browser-qa", "sabre.browser_job": key}
        network = preview = browser = None
        stop_monitor = threading.Event()
        deadline = time.monotonic() + 150
        try:
            network = self.broker.docker.networks.create("sabre-browser-" + key[:24], driver="bridge", internal=True, labels=labels,
                options={"com.docker.network.bridge.enable_ip_masquerade": "false"})
            network.reload()
            if not network.attrs.get("Internal"):
                raise DomainError("BROWSER_NETWORK_UNSAFE", "Browser QA requires a private per-job network")
            profile = metadata["project"]["profile"]
            variable = "SABRE_PYTHON_IMAGE" if profile == "python" else "SABRE_NODE_IMAGE"
            preview = self.broker.docker.containers.create(image=self.broker._image(variable), command=preview_policy.command,
                working_dir="/workspace", user="10001:10001", network=network.name, read_only=True,
                cap_drop=["ALL"], security_opt=["no-new-privileges:true"], mem_limit="1g", nano_cpus=1_000_000_000,
                pids_limit=128, dns=["127.0.0.1"], volumes={f"sabre-factory-ws-{work_id}": {"bind": "/workspace", "mode": "ro"}},
                tmpfs={CONTAINER_TEMP: "rw,nosuid,noexec,size=128m,uid=10001,gid=10001"}, labels=labels,
                environment={"HOME": CONTAINER_TEMP, "PATH": "/workspace/.venv/bin:/usr/local/bin:/usr/bin:/bin", "PYTHONPATH": "/workspace/.sabre-deps", "HOST": "0.0.0.0", "PORT": str(preview_policy.port), "NODE_ENV": "test"},  # noqa: S104 - disposable internal job network, no published ports
                log_config=docker.types.LogConfig(type="json-file", config={"max-size": "1m", "max-file": "1"}))
            preview.start()
            preview.reload()
            address = preview.attrs["NetworkSettings"]["Networks"][network.name]["IPAddress"]
            origin = f"http://{address}:{preview_policy.port}"
            browser = self.broker.docker.containers.create(image=image, command=["/usr/bin/sleep", "infinity"],
                user="10001:10001", network=network.name, read_only=True, working_dir="/opt/sabre-browser",
                cap_drop=["ALL"], security_opt=["no-new-privileges:true", "seccomp=" + browser_seccomp()], mem_limit="1g", nano_cpus=1_000_000_000,
                pids_limit=256, dns=["127.0.0.1"], init=True, shm_size="128m", labels=labels,
                tmpfs={CONTAINER_TEMP: "rw,nosuid,noexec,size=128m,uid=10001,gid=10001"},
                environment={"HOME": CONTAINER_TEMP, "PLAYWRIGHT_BROWSERS_PATH": "/opt/playwright"},
                log_config=docker.types.LogConfig(type="json-file", config={"max-size": "1m", "max-file": "1"}))
            browser.start()

            def monitor():
                while not stop_monitor.wait(0.2):
                    if cancel.is_set() or time.monotonic() >= deadline:
                        try:
                            browser.kill()
                        except docker.errors.APIError:
                            pass
                        return

            watcher = threading.Thread(target=monitor, daemon=True)
            watcher.start()
            payload = json.dumps({"origin": origin, "job": job.model_dump(mode="json")})
            # Input is passed as an argv value to a fixed script, never a shell.
            result = browser.exec_run(["node", "-e", "require('fs').writeFileSync('/tmp/browser-input.json',process.argv[1],{mode:384})", payload])
            if result.exit_code:
                raise DomainError("BROWSER_CAPABILITY_UNAVAILABLE", "The isolated browser could not initialize", 503)
            readiness = browser.exec_run(["node", "-e", "const u=process.argv[1];const end=Date.now()+20000;async function ready(){try{await fetch(u,{signal:AbortSignal.timeout(1000)});process.exit(0)}catch{if(Date.now()>end)process.exit(1);setTimeout(ready,200)}}ready()", origin])
            if cancel.is_set():
                raise DomainError("BROWSER_JOB_CANCELLED", "The browser job was cancelled", 409)
            if readiness.exit_code:
                raise DomainError("BROWSER_PREVIEW_UNAVAILABLE", "The approved preview did not become available on its registered port", 409)
            result = browser.exec_run(["node", "/opt/sabre-browser/run.mjs"])
            if cancel.is_set():
                raise DomainError("BROWSER_JOB_CANCELLED", "The browser job was cancelled", 409)
            if time.monotonic() >= deadline:
                raise DomainError("BROWSER_JOB_TIMEOUT", "The browser job exceeded its time limit", 504)
            if result.exit_code:
                # Browser stderr can contain page data. Keep it out of API and telemetry.
                raise DomainError("BROWSER_CAPABILITY_UNAVAILABLE", "The browser sandbox or evaluator failed; inspect runner availability", 503)
            captured = browser.exec_run(["/usr/bin/cat", CONTAINER_TEMP + "/browser-result.json"])
            if captured.exit_code or len(captured.output) > MAX_RESULT:
                raise DomainError("BROWSER_OUTPUT_INVALID", "The browser evidence exceeds its bound or is unavailable", 502)
            data = json.loads(captured.output)
            self.broker.guard.check(data["results"])
            if data["snapshot_digest"] != job.snapshot_digest:
                raise DomainError("BROWSER_SOURCE_STALE", "The browser evidence refers to a different source snapshot", 409)
            return data
        except docker.errors.APIError:
            if cancel.is_set():
                raise DomainError("BROWSER_JOB_CANCELLED", "The browser job was cancelled", 409) from None
            raise DomainError("BROWSER_RUNNER_FAILED", "The isolated browser runtime failed", 503) from None
        finally:
            stop_monitor.set()
            # Exact resource handles are owned by this call, never a broad Docker prune.
            for container in (browser, preview):
                if container is not None:
                    try:
                        container.remove(force=True)
                    except docker.errors.NotFound:
                        pass
            if network is not None:
                network.remove()

    async def run(self, work_id, job):
        async with self.broker.lock(work_id), self.broker.slots:
            metadata = await self.broker._ensure_workspace(work_id)
            if not metadata["project"].get("browser_preview"):
                raise DomainError("BROWSER_PREVIEW_NOT_REGISTERED", "Register a synthetic preview command and port for this project", 409)
            current = await self.broker._helper(work_id, "snapshot")
            if current["digest"] != job.snapshot_digest:
                raise DomainError("BROWSER_SOURCE_STALE", "Capture the current source snapshot before browser QA", 409)
            key = digest({"work": work_id, "key": job.idempotency_key})
            path = self.broker.root / f"{work_id}.browser-{key}.json"
            fingerprint = digest(job.model_dump(mode="json"))
            if path.exists():
                prior = json.loads(path.read_text())
                if prior["request_hash"] != fingerprint:
                    raise DomainError("IDEMPOTENCY_CONFLICT", "This browser key identifies a different job", 409)
                return prior["result"]
            event = threading.Event()
            self.running[work_id] = event
            task = asyncio.create_task(asyncio.to_thread(self._execute, work_id, job, metadata, event))
            try:
                data = await asyncio.shield(task)
                await asyncio.to_thread(self.broker._atomic_json, path, {"request_hash": fingerprint, "result": data})
                return data
            except asyncio.CancelledError:
                event.set()
                try:
                    await task
                except DomainError:
                    pass
                raise
            finally:
                self.running.pop(work_id, None)


class BrowserQAService:
    def __init__(self, repository, executor, artifacts, guard):
        self.repository, self.executor, self.artifacts, self.guard = repository, executor, artifacts, guard

    async def run(self, work, request: BrowserJob):
        current = await self.repository.work(work.id)
        if current.status in {"cancelled", "completed"} or current.plan_revision != work.plan_revision:
            raise DomainError("BROWSER_RUN_NOT_ACTIVE", "Browser jobs require the current active run revision", 409)
        key = "browser-v1:" + digest({"work": work.id, "revision": work.plan_revision, "key": request.idempotency_key})
        data = request.model_dump(mode="json")
        self.guard.check(data)
        prior = await self.repository.begin_command(key, data)
        if prior:
            if prior["request_hash"] != digest(data):
                raise DomainError("IDEMPOTENCY_CONFLICT", "This browser key identifies a different job", 409)
            if prior["state"] == "completed":
                snapshot = await self.executor.snapshot(work.id)
                if snapshot["digest"] != request.snapshot_digest:
                    raise DomainError("BROWSER_SOURCE_STALE", "The recorded browser report belongs to an earlier source snapshot", 409)
                return BrowserReport.model_validate(prior["result"])
        raw = await self.executor.browser_qa(work.id, request)
        self.guard.check(raw["results"])
        evidence = []
        for item in raw.pop("artifacts"):
            content = base64.b64decode(item.pop("content"), validate=True)
            if len(content) > 16_000_000:
                raise DomainError("BROWSER_ARTIFACT_TOO_LARGE", "The browser artifact exceeds the storage limit", 502)
            if item["kind"] == "trace":
                self._inspect_trace(content)
            artifact_digest = self.artifacts.put(content)
            evidence.append(BrowserEvidence(**item, digest=artifact_digest, size=len(content)))
        raw["artifacts"] = evidence
        raw["work_id"] = work.id
        report = BrowserReport.model_validate(raw)
        report_digest = self.artifacts.put(report.model_dump_json())
        report.artifacts.append(BrowserEvidence(kind="report", digest=report_digest, size=len(report.model_dump_json().encode()), media_type="application/json"))
        await self.repository.finish_effect(key, report.model_dump(mode="json"))
        return report

    def _inspect_trace(self, content):
        import zipfile
        try:
            with zipfile.ZipFile(io.BytesIO(content)) as archive:
                infos = archive.infolist()
                if len(infos) > 1000 or sum(item.file_size for item in infos) > 32_000_000:
                    raise ValueError
                for item in infos:
                    if not item.filename.endswith((".png", ".jpeg", ".jpg")):
                        self.guard.check(archive.read(item).decode("utf-8", errors="replace"))
        except (ValueError, zipfile.BadZipFile):
            raise DomainError("BROWSER_TRACE_INVALID", "The trace exceeded its inspection limit", 502) from None


def browser_tool_metadata():
    schema = BrowserJob.model_json_schema()
    properties = {key: schema["properties"][key] for key in ("viewports", "operations", "accessibility", "trace")}
    return {"name": "browser_verify", "description": "Requires an owner-registered synthetic preview and an available pinned browser runner. Run semantic Playwright interactions and capture desktop/mobile screenshots, overflow, errors, accessibility findings and restricted traces for the exact source snapshot. Visual model review is unavailable; browser success does not prove good UX or accessibility compliance.",
        "effect": "read", "roles": ["qa", "designer"], "scope": "workspace", "source": "builtin",
        "input_schema": {"type": "object", "properties": properties, "required": ["viewports", "operations"], "additionalProperties": False, "$defs": schema.get("$defs", {})}}


async def attach_browser_tools(catalog, service, work, role, *, attempt_key, authorization_role=None):
    from sabre.tools import ToolDefinition, ToolPolicy

    if role not in {"qa", "designer"}:
        return
    project = await service.repository.project(work.project_id)
    if project.browser_preview is None:
        return

    async def verify(viewports, operations, accessibility=True, trace=True):
        snapshot = await service.executor.snapshot(work.id)
        job = BrowserJob.model_validate({"version": 1, "idempotency_key": "browser:" + digest({"attempt": attempt_key, "snapshot": snapshot["digest"], "viewports": viewports, "operations": operations}),
            "snapshot_digest": snapshot["digest"], "viewports": viewports, "operations": operations, "accessibility": accessibility, "trace": trace}, strict=True)
        return (await service.run(work, job)).model_dump(mode="json")

    metadata = browser_tool_metadata()
    catalog.register(ToolDefinition(metadata["name"], metadata["description"], metadata["input_schema"],
        ToolPolicy(frozenset({authorization_role or role}), "read", 180), verify))


def install_browser_routes(application, service_accessor):
    from fastapi import APIRouter
    from fastapi.responses import Response

    router = APIRouter()

    def service():
        value = getattr(service_accessor().queue, "browser_qa", None)
        if value is None:
            raise DomainError("BROWSER_CAPABILITY_UNAVAILABLE", "The browser evaluator is unavailable", 503)
        return value

    @router.post("/api/v1/work/{work_id}/browser-qa", response_model=BrowserReport)
    async def run(work_id: str, request: BrowserJob):
        from sabre.execution_observer import observe
        work = await service_accessor().repository.work(work_id)
        async with observe(service_accessor().repository, work, "tool", "browser_verify"):
            return await service().run(work, request)

    @router.get("/api/v1/work/{work_id}/browser-reports", response_model=list[BrowserReport])
    async def reports(work_id: str):
        await service_accessor().repository.work(work_id)
        async with service_accessor().repository.connection() as conn:
            rows = await (await conn.execute("SELECT result FROM effects WHERE operation_key LIKE 'browser-v1:%%' AND state='completed' AND result->>'work_id'=%s LIMIT 100", (work_id,))).fetchall()
        return [BrowserReport.model_validate(row["result"]) for row in rows]

    @router.get("/api/v1/work/{work_id}/browser-artifacts/{artifact_digest}")
    async def artifact(work_id: str, artifact_digest: str):
        all_reports = await reports(work_id)
        item = next((item for report in all_reports for item in report.artifacts if item.digest == artifact_digest), None)
        if item is None:
            raise DomainError("BROWSER_ARTIFACT_NOT_FOUND", "This artifact is not assigned to this run", 404)
        if item.review_required:
            raise DomainError("BROWSER_ARTIFACT_REVIEW_REQUIRED", "Inspect and redact this trace before exposing it", 403)
        return Response(service().artifacts.get(artifact_digest), media_type=item.media_type,
            headers={"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"})

    application.include_router(router)
