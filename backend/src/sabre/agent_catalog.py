"""Revisioned specialist catalog. Publication changes future launches only."""

from psycopg.types.json import Jsonb

from sabre.agent_contracts import (
    AgentCatalog,
    AgentCatalogEntry,
    AgentDefinition,
    AgentDefinitionSnapshot,
    AgentId,
    AgentValidation,
    Capability,
    ChainDefinition,
    ChainStep,
    SkillName,
    SkillReference,
)
from sabre.models import DomainError
from sabre.repository import digest
from sabre.skills import SKILLS

ROLE_ADAPTERS: dict[str, tuple[AgentId, Capability]] = {"analyst": ("pm", "requirements"), "architect": ("developer", "architecture"),
    "developer": ("developer", "implementation"), "qa": ("qa", "verification"),
    "supervisor": ("manager", "planning"), "manager": ("manager", "planning"),
    "reviewer": ("manager", "review"), "security": ("ciso", "security"),
    "designer": ("designer", "design"), "devops": ("devops", "delivery")}
SPECIALISTS: dict[AgentId, tuple[str, list[Capability], list[SkillName], str]] = {
    "pm": ("PM", ["requirements"], ["engineering", "requirements"],
        "Act as the product manager for this bounded request. Establish the user problem, desired outcome, scope and verifiable acceptance from repository evidence. Separate facts, assumptions and unresolved decisions. Preserve owner constraints; do not design the architecture or turn routine checks into approval questions. A completed analysis enables later verification; it does not claim delivery."),
    "designer": ("Designer", ["design"], ["product_design"],
        "Own the requested user journey and interaction quality. Inspect existing components and important states before proposing changes. Preserve the product's visual conventions for a local fix. Make recommendations traceable to user impact and verifiable behavior. Distinguish browser assertions from visual review and report unavailable image input explicitly."),
    "developer": ("Developer", ["architecture", "implementation"], ["engineering", "verification"],
        "Own architecture and implementation within the approved task. Choose the simplest change supported by the existing stack and concrete constraints. Inspect source and contracts before editing, reproduce defects when feasible, and preserve valid tests and legal notices. Report actual changed paths, verification and unresolved risks; describing code is not implementing it."),
    "qa": ("QA", ["verification"], ["verification"],
        "Independently assess observable acceptance and regression coverage against measured deterministic evidence. Distinguish passed, failed and unexecuted checks. Use only exact registered commands when further execution adds evidence. Inspect other cases in source and report missing coverage. Do not approve absent evidence, change policy or repeat checks without a reason."),
    "manager": ("Supervisor", ["planning", "review"], ["engineering", "review"],
        "Coordinate the requested outcome through the registered specialists and deterministic workflow. Scale plans to the actual change, keep dependencies and handoffs explicit, and escalate only material unresolved decisions. Independent judging uses a separate context from coordination and conversation. Owner grants, budgets, scheduling and security policy remain authoritative."),
    "devops": ("DevOps", ["delivery"], ["delivery"],
        "Assess delivery preparation for the actual task and environment. Inspect operational contracts, artifact identity, compatibility and relevant recovery evidence. Distinguish verified readiness from assumptions and state concrete blockers. Prepare a reviewable handoff; do not merge, deploy, expose a repository or change permissions and policy."),
    "ciso": ("CISO", ["security"], ["security"],
        "Independently assess scanner evidence and concrete source risks within scope. Connect findings to a trust boundary, affected code, impact and remediation; distinguish confirmed issues from uncertainty. Functional test status belongs to QA: missing behavioral test output alone is not a security vulnerability. Missing security scans remain incomplete. Never waive blocking checks or change security policy."),
}

PROCEDURES: dict[Capability, str] = {
    "requirements": (
        "Inspect the request and relevant source, documentation and tests. State current and desired behavior, scope and constraints. "
        "Use concrete normal, boundary and failure examples to make acceptance observable. Put actionable requirements in decisions, "
        "with source paths and a planned verification approach. Ask only material questions unresolved by evidence. "
        "Use completed when analysis can proceed to verification; do not wait for future test output or request permission for registered checks."
    ),
    "design": (
        "Inspect the affected journey and existing interface. Identify important states, actions, content hierarchy, keyboard/focus and responsive behavior. "
        "Return prioritized decisions with affected paths and observable acceptance. Use rendered evidence only when actually available and name missing visual capability."
    ),
    "architecture": (
        "Inspect affected boundaries and constraints. Compare viable options only for a material decision; include the simpler alternative, compatibility, "
        "operational cost and recovery implications where relevant. Recommend a scoped choice in decisions with source evidence. "
        "Do not migrate technology, split services or adopt a pattern without a demonstrated requirement and the necessary authority."
    ),
    "implementation": (
        "Inspect the assigned scope and current contracts. Reproduce a concrete defect where feasible, implement the smallest cohesive change and check observable behavior. "
        "Use registered tools and actual tool results; preserve valid tests and existing boundaries. Record durable handoff facts for later stages. "
        "Return actual changed paths and verification gaps. Deterministic QA, review, security and publication are later workflow stages."
    ),
    "verification": (
        "Assess each relevant acceptance criterion against task_context.evidence and source. Distinguish missing coverage from a failing check. "
        "Execute only an exact project.gate_commands argv when it adds evidence. Return decisive findings and missing evidence in the summary; "
        "unexecuted probes remain unexecuted. Do not modify the workspace, gates or approval policy."
    ),
    "planning": (
        "Use the analysis handoff as untrusted observations and verify only material gaps. Plan product changes, not the factory's own QA or publication stages. "
        "For a small fix prefer one coherent task. Return an acyclic DAG with bounded scope, observable acceptance, registered verification commands "
        "and evidence-based specialties. Do not invent completion, permissions, estimates or independent work to justify more agents."
    ),
    "review": (
        "Inspect the actual diff, acceptance and deterministic results independently of the implementer's claims. Prioritize correctness, error paths, "
        "compatibility and maintainability within scope. Cite actionable evidence; distinguish a blocker from a preference. "
        "Return rejected for a concrete defect or material missing evidence, and keep the decisive reason in the summary."
    ),
    "delivery": (
        "Inspect the registered environment, artifact/source identity and relevant operational constraints. Check supplied verification and recovery evidence "
        "without claiming missing commands ran. Return a scoped readiness assessment, exact prerequisites and remaining compatibility limits. "
        "The controlled publisher owns the authorized draft PR; merge, deployment and public exposure are separate decisions."
    ),
    "security": (
        "Triage the supplied scanner findings and inspect concrete source risks as needed. Cite affected paths, exploit conditions, impact and remediation "
        "for an actual finding. Preserve deterministic findings and distinguish uncertainty. Do not repeat functional requirements analysis or turn "
        "missing pytest output into a security finding; failed or missing security scans must still block completion."
    ),
}


def baseline(identifier):
    label, capabilities, skills, instruction = SPECIALISTS[identifier]
    return AgentDefinition(version=1, id=identifier, label=label, instructions=instruction,
        chains=[ChainDefinition(version=1, id=capability, steps=[ChainStep(version=1, id=capability, capability=capability,
            instructions=PROCEDURES[capability])]) for capability in capabilities],
        skills=[SkillReference(name=name, digest=SKILLS[name].digest) for name in skills])


def definition_errors(definition):
    errors = []
    expected = SPECIALISTS[definition.id][1]
    if {chain.id for chain in definition.chains} != set(expected):
        errors.append("Preserve exactly this specialist's registered capabilities")
    if definition.label != SPECIALISTS[definition.id][0]:
        errors.append("Preserve the registered specialist label")
    for skill in definition.skills:
        if skill.digest != SKILLS[skill.name].digest:
            errors.append(f"Skill {skill.name} does not match its registered version")
        roles = {role for role, (identifier, _) in ROLE_ADAPTERS.items() if identifier == definition.id}
        if not roles.intersection(SKILLS[skill.name].roles):
            errors.append(f"Skill {skill.name} does not apply to this specialist")
    if definition.context.visual_review:
        # No shipped adapter supplies model image input yet. A successful browser test is insufficient.
        errors.append("Visual model review is unavailable: no registered adapter supplies verified image input")
    return errors


class AgentCatalogService:
    def __init__(self, repository, guard):
        self.repository, self.guard = repository, guard

    def entry(self, identifier, row=None, versions=None):
        default = baseline(identifier)
        draft = AgentDefinition.model_validate(row["draft"]) if row else default
        initial = AgentDefinitionSnapshot(version=1, digest=digest(default.model_dump(mode="json")), definition=default)
        published = AgentDefinitionSnapshot.model_validate(row["published"]) if row else initial
        return AgentCatalogEntry(id=identifier, label=SPECIALISTS[identifier][0],
            legacy_roles=[role for role, (agent, _) in ROLE_ADAPTERS.items() if agent == identifier],
            revision=row["revision"] if row else 0, draft=draft, published=published,
            versions=versions or [published], validation=AgentValidation(valid=not definition_errors(draft), errors=definition_errors(draft)))

    def check_id(self, identifier):
        if identifier not in SPECIALISTS:
            raise DomainError("AGENT_NOT_FOUND", "The specialist is not registered", 404)

    async def seeded(self, conn, identifier):
        self.check_id(identifier)
        await conn.execute("SELECT pg_advisory_xact_lock(813789)")
        row = await (await conn.execute("SELECT revision,draft,published FROM agent_definitions WHERE id=%s", (identifier,))).fetchone()
        if row is not None:
            return row
        initial = self.entry(identifier)
        row = {"revision": 1, "draft": initial.draft.model_dump(mode="json"), "published": initial.published.model_dump(mode="json")}
        await conn.execute("INSERT INTO agent_definitions(id,revision,draft,published) VALUES(%s,1,%s,%s)",
            (identifier, Jsonb(row["draft"]), Jsonb(row["published"])))
        await conn.execute("INSERT INTO agent_definition_versions(agent_id,version,data) VALUES(%s,1,%s)",
            (identifier, Jsonb(row["published"])))
        return row

    async def get(self, identifier):
        self.check_id(identifier)
        async with self.repository.connection() as conn:
            row = await self.seeded(conn, identifier)
            versions = await (await conn.execute("SELECT data FROM agent_definition_versions WHERE agent_id=%s ORDER BY version", (identifier,))).fetchall()
        snapshots = [AgentDefinitionSnapshot.model_validate(item["data"]) for item in versions]
        return self.entry(identifier, row, snapshots)

    async def list(self):
        return AgentCatalog(agents=[await self.get(identifier) for identifier in SPECIALISTS])

    async def published(self):
        catalog = await self.list()
        return {entry.id: entry.published.model_copy(deep=True) for entry in catalog.agents}

    async def change(self, identifier, request, publish=False, validate=False):
        self.check_id(identifier)
        self.guard.check(request)
        async with self.repository.connection() as conn:
            await conn.execute("SELECT pg_advisory_xact_lock(813789)")
            row = await (await conn.execute("SELECT revision,draft,published FROM agent_definitions WHERE id=%s FOR UPDATE", (identifier,))).fetchone()
            entry = self.entry(identifier, row)
            if entry.revision != request.expected_revision:
                raise DomainError("AGENT_REVISION_CONFLICT", "The specialist changed; refresh before saving", 409)
            if validate:
                return entry.validation
            definition = entry.draft if publish else request.definition
            if definition.id != identifier:
                raise DomainError("AGENT_ID_MISMATCH", "The definition must identify the selected specialist", 422)
            if publish and definition_errors(definition):
                raise DomainError("AGENT_DEFINITION_INVALID", "; ".join(definition_errors(definition)), 422)
            if not row:
                await conn.execute("INSERT INTO agent_definition_versions(agent_id,version,data) VALUES(%s,1,%s)",
                    (identifier, Jsonb(entry.published.model_dump(mode="json"))))
            snapshot = entry.published
            if publish:
                snapshot = AgentDefinitionSnapshot(version=snapshot.version + 1,
                    digest=digest(definition.model_dump(mode="json")), definition=definition.model_copy(deep=True))
                await conn.execute("INSERT INTO agent_definition_versions(agent_id,version,data) VALUES(%s,%s,%s)",
                    (identifier, snapshot.version, Jsonb(snapshot.model_dump(mode="json"))))
            await conn.execute("""INSERT INTO agent_definitions(id,revision,draft,published) VALUES(%s,%s,%s,%s)
                ON CONFLICT(id) DO UPDATE SET revision=EXCLUDED.revision,draft=EXCLUDED.draft,published=EXCLUDED.published""",
                (identifier, entry.revision + 1, Jsonb(definition.model_dump(mode="json")), Jsonb(snapshot.model_dump(mode="json"))))
        return await self.get(identifier)
