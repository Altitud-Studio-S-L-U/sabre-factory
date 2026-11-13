"""Secret boundaries and the independent security assessment graph."""

import base64
import binascii
import codecs
import hashlib
import json
import re
from collections.abc import Iterable
from datetime import UTC, datetime
from inspect import isawaitable
from typing import TYPE_CHECKING, Any, Literal, TypedDict
from urllib.parse import urlsplit

from pydantic import BaseModel, Field

from sabre.models import Contract, DomainError, SecurityException, SecurityFinding, now

if TYPE_CHECKING:
    from langchain_core.runnables import RunnableConfig

RULES_VERSION = "sabre-security-v1"
Severity = Literal["info", "low", "medium", "high", "critical"]


def _severity(value: str) -> Severity:
    values: dict[str, Severity] = {"info": "info", "low": "low", "medium": "medium", "high": "high", "critical": "critical"}
    return values.get(value.lower(), "medium")


def _line(value: Any) -> int | None:
    return value if isinstance(value, int) and not isinstance(value, bool) and value > 0 else None


def active_security_exceptions(work_id: str, snapshot_digest: str, rules_version: str,
                               exceptions: Iterable[SecurityException], *, plan_revision: int = 1,
                               at: datetime | None = None) -> list[SecurityException]:
    moment = at or now()
    return sorted((exception for exception in exceptions
                   if exception.work_id == work_id and exception.plan_revision == plan_revision
                   and exception.snapshot_digest == snapshot_digest and exception.rules_version == rules_version
                   and exception.approved_by == "owner" and exception.approved_at <= moment
                   and exception.revoked_at is None and exception.expires_at > moment), key=lambda item: item.id)


def security_policy_digest(work_id: str, snapshot_digest: str, rules_version: str,
                           baseline: list[str], exceptions: Iterable[SecurityException], *,
                           plan_revision: int = 1, at: datetime | None = None) -> str:
    active = active_security_exceptions(work_id, snapshot_digest, rules_version, exceptions, plan_revision=plan_revision, at=at)
    policy = {"work_id": work_id, "plan_revision": plan_revision, "snapshot_digest": snapshot_digest,
              "rules_version": rules_version, "baseline": sorted(set(baseline)),
              "exceptions": [{"id": item.id, "fingerprint": item.fingerprint,
                              "expires_at": item.expires_at.astimezone(UTC).isoformat(),
                              "approved_at": item.approved_at.astimezone(UTC).isoformat(),
                              "justification": item.justification} for item in active]}
    return hashlib.sha256(json.dumps(policy, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def is_blocking_finding(finding: SecurityFinding) -> bool:
    """Use with findings annotated by the validated security policy, never model input."""
    return finding.category in {"secret", "scanner_error"} or (
        finding.severity in {"high", "critical"} and not finding.baseline and finding.exception_id is None
    )


class SecretGuard:
    """Detect supported credential patterns without including the match in errors.

    This pre-egress check complements the full repository scanner. It does not
    claim to recognize arbitrary information that an owner considers sensitive.
    """

    credential_url_pattern = re.compile(r"(?i)\b(?:https?|postgres(?:ql)?|mysql|mariadb|redis|rediss|amqps?|mongodb(?:\+srv)?|mssql)://[^/\s:@]+:[^/\s@]+@")
    # Keep control characters in the candidate: URL parsers may silently remove them.
    url_token_pattern = re.compile(r"""[^ '"<>`]+""")
    patterns = (
        re.compile(r"\bsabre_d_[A-Za-z0-9_-]{43,}"),
        re.compile(r"\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}"),
        re.compile(r"\bgh[pousr]_[A-Za-z0-9]{20,}"),
        re.compile(r"\bgithub_pat_[A-Za-z0-9_]{20,}"),
        re.compile(r"\bxox[baprs]-[A-Za-z0-9-]{15,}"),
        re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----"),
        re.compile(r"(?i)(?:api[_-]?key|access[_-]?token|client[_-]?secret|password)\s*[=:]\s*[\"']([^\"'\s]{20,})[\"']"),
        re.compile(r"\bAKIA[A-Z0-9]{16}\b"),
        credential_url_pattern,
    )

    def __init__(self, known_secrets: Iterable[str] = ()):
        self.known_secrets = tuple(secret for secret in known_secrets if secret and len(secret) >= 4)

    @classmethod
    def _is_secret_match(cls, match: re.Match[str]) -> bool:
        if match.re is not cls.credential_url_pattern:
            return True
        token = cls.url_token_pattern.match(match.string, match.start())
        if token is None:
            return True
        candidate = token.group()
        if candidate.count("@") != 1 or "%" in candidate or "\\" in candidate or any(ord(c) < 32 or ord(c) == 127 for c in candidate):
            return True
        try:
            parsed = urlsplit(candidate)
        except ValueError:
            return True
        # Only this literal documentation placeholder is non-secret; paths and
        # reserved domains never waive other patterns or registered credentials.
        return not (parsed.scheme in {"http", "https"} and parsed.netloc in {
            "user:password@example.com", "user:password@example.org", "user:password@example.net",
        })

    def check(self, value: Any) -> None:
        if isinstance(value, BaseModel):
            value = value.model_dump(mode="json")
        if isinstance(value, dict):
            for key, item in value.items():
                self.check(str(key))
                self.check(item)
            return
        if isinstance(value, list | tuple | set):
            for item in value:
                self.check(item)
            return
        text = value if isinstance(value, str) else str(value)
        if any(secret in text for secret in self.known_secrets) or any(
            self._is_secret_match(match) for pattern in self.patterns for match in pattern.finditer(text)):
            raise DomainError("SECRET_DETECTED", "Content containing a possible credential was blocked", 422)

    def redact(self, value: Any) -> Any:
        if isinstance(value, str):
            for secret in self.known_secrets:
                value = value.replace(secret, "[REDACTED]")
            for pattern in self.patterns:
                value = pattern.sub(lambda match: "[REDACTED]" if self._is_secret_match(match) else match.group(), value)
            return value
        if isinstance(value, dict):
            return {str(key): self.redact(item) for key, item in value.items()}
        if isinstance(value, list | tuple):
            return [self.redact(item) for item in value]
        return value

    def check_snapshot(self, snapshot: dict[str, Any]) -> None:
        """Inspect declared snapshot bytes before any external publication."""
        if not isinstance(snapshot, dict) or not isinstance(snapshot.get("files"), list):
            raise DomainError("INVALID_SNAPSHOT", "The snapshot does not contain a valid file list", 422)
        self.check({key: value for key, value in snapshot.items() if key != "files"})
        for entry in snapshot["files"]:
            if not isinstance(entry, dict) or not isinstance(entry.get("content"), str):
                raise DomainError("INVALID_SNAPSHOT", "File content is invalid", 422)
            self.check({key: value for key, value in entry.items() if key != "content"})
            encoding = entry.get("encoding", "utf-8")
            if encoding == "utf-8":
                self.check(entry["content"])
                try:
                    entry["content"].encode("utf-8")
                except UnicodeEncodeError:
                    raise DomainError("INVALID_SNAPSHOT", "The file does not contain valid UTF-8", 422) from None
            elif encoding == "base64":
                try:
                    raw = base64.b64decode(entry["content"], validate=True)
                except (ValueError, binascii.Error):
                    raise DomainError("INVALID_SNAPSHOT", "The file does not contain valid base64", 422) from None
                self.check(raw.decode("utf-8", errors="ignore"))
                for bom, codec in ((codecs.BOM_UTF32_LE, "utf-32"), (codecs.BOM_UTF32_BE, "utf-32"),
                                   (codecs.BOM_UTF16_LE, "utf-16"), (codecs.BOM_UTF16_BE, "utf-16")):
                    if raw.startswith(bom):
                        self.check(raw.decode(codec, errors="ignore"))
                        break
            else:
                raise DomainError("INVALID_SNAPSHOT", "The file encoding is not allowed", 422)


def fingerprint(scanner: str, rule: str, path: str = "", location: str = "") -> str:
    return hashlib.sha256(json.dumps([scanner, rule, path, location]).encode()).hexdigest()


def scanner_error(scanner: str) -> SecurityFinding:
    return SecurityFinding(
        fingerprint=fingerprint(scanner, "scanner_error"),
        scanner=scanner,
        category="scanner_error",
        severity="high",
        title=f"Could not complete the required check: {scanner}",
    )


def finding_locations(findings: list[SecurityFinding], limit: int = 5) -> str:
    """Where findings are: path, line and rule, never content. Paths and rules come from the scanned repository
    and the rule set, so anything outside a plain path or identifier is described instead of repeated."""
    places = []
    for finding in findings[:limit]:
        path = (finding.path or "").removeprefix("/workspace/")
        place = path if re.fullmatch(r"[A-Za-z0-9._@+-][A-Za-z0-9._@+/-]{0,159}", path) else "a path with unusual characters"
        rule = finding.reference if finding.reference and re.fullmatch(r"[A-Za-z0-9._-]{1,80}", finding.reference) else "unnamed rule"
        places.append(f"{place}{f' line {finding.line}' if finding.line else ''} ({rule})")
    more = len(findings) - len(places)
    return "; ".join(places) + (f"; and {more} more" if more > 0 else "")


def parse_findings(scanner: str, payload: Any) -> list[SecurityFinding]:
    """Parse only scanner report fields, never raw secrets or process output."""
    findings: list[SecurityFinding] = []
    if scanner == "gitleaks":
        if not isinstance(payload, list):
            raise ValueError("Gitleaks report must be an array")
        for row in payload:
            path, rule = str(row.get("File", "")), str(row.get("RuleID", "unknown"))
            findings.append(SecurityFinding(
                fingerprint=fingerprint(scanner, rule, path, str(row.get("StartLine", ""))),
                scanner=scanner, category="secret", severity="critical",
                title="Possible secret detected", path=path, reference=rule,
                line=_line(row.get("StartLine")),
                remediation="Revoke or rotate the detected credential, remove it from code and check history before resubmitting the project.",
            ))
    elif scanner == "trivy":
        if not isinstance(payload, dict) or "SchemaVersion" not in payload:
            raise ValueError("Trivy report is incomplete")
        for result in payload.get("Results", []):
            path = str(result.get("Target", ""))
            for row in result.get("Vulnerabilities", []) or []:
                rule = str(row["VulnerabilityID"])
                severity = _severity(str(row.get("Severity", "UNKNOWN")))
                fixed = str(row.get("FixedVersion") or "")
                remediation = (f"Update {row.get('PkgName', 'the dependency')} to a patched version ({fixed}); verify compatibility and run the tests again."
                               if fixed else f"Investigate the applicability of {rule}; the advisory does not identify a patched version. Propose mitigation and repeat the scan.")
                findings.append(SecurityFinding(
                    fingerprint=fingerprint(scanner, rule, path, json.dumps([row.get("PkgName", ""), row.get("InstalledVersion", ""), severity])),
                    scanner=scanner, category="vulnerability",
                    severity=severity,
                    title=f"{rule}: {row.get('PkgName', 'dependency')}", path=path, reference=rule,
                    remediation=remediation,
                ))
            for row in result.get("Misconfigurations", []) or []:
                if row.get("Status") == "PASS":
                    continue
                rule = str(row["ID"])
                severity = _severity(str(row.get("Severity", "MEDIUM")))
                findings.append(SecurityFinding(
                    fingerprint=fingerprint(scanner, rule, path, json.dumps([severity, row.get("CauseMetadata", {})], sort_keys=True)), scanner=scanner,
                    category="configuration", severity=severity,
                    title=str(row.get("Title", rule)), path=path, reference=rule,
                    remediation=str(row.get("Resolution") or f"Correct the configuration according to rule {rule} and repeat the scan."),
                ))
    elif scanner == "semgrep":
        if not isinstance(payload, dict) or "results" not in payload or payload.get("errors"):
            raise ValueError("Semgrep report is incomplete")
        for row in payload["results"]:
            rule, path = str(row["check_id"]), str(row["path"])
            extra = row.get("extra", {})
            severity = _severity({"ERROR": "high", "WARNING": "medium", "INFO": "low"}.get(str(extra.get("severity", "WARNING")), "medium"))
            findings.append(SecurityFinding(
                fingerprint=fingerprint(scanner, rule, path, json.dumps([row.get("start", {}).get("line", ""), extra.get("lines", ""), severity])),
                scanner=scanner, category="code", severity=severity,
                title=rule, path=path, reference=rule,
                line=_line(row.get("start", {}).get("line")),
                remediation=f"Review rule {rule} in {path}, remove the unsafe construction and verify a regression test.",
            ))
    else:
        raise ValueError("Unknown scanner")
    SecretGuard().check([finding.model_dump() for finding in findings])
    return findings


class ScannerClient:
    def __init__(self, executor):
        self.executor = executor

    async def scan_snapshot(self, work_id: str, digest: str, baseline: list[str]) -> list[SecurityFinding]:
        return await self.executor.scan_snapshot(work_id, digest, baseline)

    async def security_version(self, work_id: str) -> str:
        return await self.executor.security_version(work_id)

    async def current_digest(self, work_id: str) -> str:
        return (await self.executor.snapshot(work_id))["digest"]


class SecurityReport(Contract):
    snapshot_digest: str
    rules_version: str
    findings: list[SecurityFinding]
    blocked: bool
    policy_digest: str = ""
    exception_ids: list[str] = Field(default_factory=list)


class SecurityState(TypedDict):
    work_id: str
    snapshot_digest: str
    baseline: list[str]
    findings: list[SecurityFinding]
    blocked: bool
    rules_version: str
    exceptions: list[SecurityException]
    exception_ids: list[str]
    policy_digest: str
    plan_revision: int


class SecurityService:
    def __init__(self, scanner, checkpointer=None, analyst=None, guard: SecretGuard | None = None):
        # The broker uses parsing and redaction without loading orchestration or model SDKs.
        from langgraph.graph import END, START, StateGraph

        self.scanner = scanner
        self.analyst = analyst
        self.guard = guard or SecretGuard()
        self.durability: Literal["sync"] | None = "sync" if checkpointer is not None else None
        builder = StateGraph(SecurityState)
        builder.add_node("collect", self._guarded_node(self._collect))
        builder.add_node("triage", self._guarded_node(self._triage))
        builder.add_node("analyst", self._guarded_node(self._analyst))
        builder.add_node("exceptions", self._guarded_node(self._exceptions))
        builder.add_node("decide", self._guarded_node(self._decide))
        builder.add_edge(START, "collect")
        builder.add_edge("collect", "triage")
        builder.add_edge("triage", "analyst")
        builder.add_edge("analyst", "exceptions")
        builder.add_edge("exceptions", "decide")
        builder.add_edge("decide", END)
        self.graph = builder.compile(checkpointer=checkpointer)

    def _guarded_node(self, handler):
        from sabre.error_boundaries import guarded_call

        async def guarded(state: SecurityState):
            async def invoke():
                result = handler(state)
                return await result if isawaitable(result) else result

            return await guarded_call(invoke, self.guard, "SECURITY_REVIEW_FAILED")
        return guarded

    async def _collect(self, state: SecurityState):
        version = await self.scanner.security_version(state["work_id"]) if hasattr(self.scanner, "security_version") else RULES_VERSION
        if version != state["rules_version"]:
            raise DomainError("SECURITY_RULES_CHANGED", "Rules or the vulnerability database changed during review")
        findings = await self.scanner.scan_snapshot(state["work_id"], state["snapshot_digest"], state["baseline"])
        if hasattr(self.scanner, "security_version") and await self.scanner.security_version(state["work_id"]) != version:
            raise DomainError("SECURITY_RULES_CHANGED", "Rules or the vulnerability database changed during review")
        parsed = [SecurityFinding.model_validate(item) for item in findings]
        self.guard.check(parsed)
        return {"findings": parsed, "rules_version": version}

    def _triage(self, state: SecurityState):
        return {"findings": [finding.model_copy(update={
            "baseline": finding.fingerprint in state["baseline"] and finding.category not in {"secret", "scanner_error"},
            "exception_id": None,
        }) for finding in state["findings"]]}

    async def _assert_current(self, state: SecurityState):
        if hasattr(self.scanner, "current_digest") and await self.scanner.current_digest(state["work_id"]) != state["snapshot_digest"]:
            raise DomainError("STALE_SNAPSHOT", "The code changed during security review")
        if hasattr(self.scanner, "security_version") and await self.scanner.security_version(state["work_id"]) != state["rules_version"]:
            raise DomainError("SECURITY_RULES_CHANGED", "Rules or the vulnerability database changed during review")

    async def _analyst(self, state: SecurityState):
        if self.analyst is None:
            return {}
        await self._assert_current(state)
        original = [item.model_copy(deep=True) for item in state["findings"]]
        additions = await self.analyst(state["work_id"], [item.model_copy(deep=True) for item in original])
        await self._assert_current(state)
        fingerprints = {item.fingerprint for item in original}
        for addition in additions:
            parsed = SecurityFinding.model_validate(addition).model_copy(update={"baseline": False, "exception_id": None})
            self.guard.check(parsed)
            if parsed.fingerprint not in fingerprints:
                original.append(parsed)
                fingerprints.add(parsed.fingerprint)
        return {"findings": original}

    def _exceptions(self, state: SecurityState):
        moment = now()
        policy = security_policy_digest(state["work_id"], state["snapshot_digest"], state["rules_version"], state["baseline"], state["exceptions"], plan_revision=state["plan_revision"], at=moment)
        if policy != state["policy_digest"]:
            raise DomainError("SECURITY_POLICY_CHANGED", "The exception policy changed or expired during review")
        active = active_security_exceptions(state["work_id"], state["snapshot_digest"], state["rules_version"], state["exceptions"], plan_revision=state["plan_revision"], at=moment)
        by_fingerprint = {item.fingerprint: item.id for item in active}
        findings = [finding.model_copy(update={"exception_id": by_fingerprint.get(finding.fingerprint)
                    if finding.category not in {"secret", "scanner_error"} else None}) for finding in state["findings"]]
        return {"findings": findings, "exception_ids": sorted({finding.exception_id for finding in findings if finding.exception_id})}

    def _decide(self, state: SecurityState):
        return {"blocked": any(is_blocking_finding(finding) for finding in state["findings"])}

    async def review(self, work_id: str, digest: str, baseline: list[str], exceptions: list[SecurityException] | None = None, *, plan_revision: int = 1) -> SecurityReport:
        from sabre.error_boundaries import guarded_call

        exceptions = exceptions or []
        self.guard.check({"work_id": work_id, "digest": digest, "baseline": baseline, "exceptions": exceptions})
        version = await guarded_call(self.scanner.security_version, self.guard, "SECURITY_REVIEW_FAILED", work_id) if hasattr(self.scanner, "security_version") else RULES_VERSION
        self.guard.check(version)
        policy = security_policy_digest(work_id, digest, version, baseline, exceptions, plan_revision=plan_revision)
        initial: SecurityState = {"work_id": work_id, "snapshot_digest": digest, "baseline": baseline, "findings": [], "blocked": True, "rules_version": version,
                                  "exceptions": exceptions, "exception_ids": [], "policy_digest": policy, "plan_revision": plan_revision}
        config: RunnableConfig = {"configurable": {"thread_id": f"security:{work_id}:{digest}:{policy}"}}
        result = await self.graph.ainvoke(
            initial, config=config, durability=self.durability,
        )
        return SecurityReport(snapshot_digest=digest, rules_version=result["rules_version"], findings=result["findings"], blocked=result["blocked"], policy_digest=result["policy_digest"], exception_ids=result["exception_ids"])
