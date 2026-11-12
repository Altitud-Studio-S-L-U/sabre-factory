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
    "pm": ("PM", ["requirements"], ["engineering"], "Inspect requirements and acceptance criteria using repository evidence."),
    "designer": ("Designer", ["design"], [], "Inspect UX, interaction and visual requirements. Identify missing rendered evidence; never claim visual review without a capable model and actual image input."),
    "developer": ("Developer", ["architecture", "implementation"], ["engineering", "verification"], "Own code architecture and implementation. Preserve existing stack and valid verification."),
    "qa": ("QA", ["verification"], ["verification"], "Independently verify observable behavior and acceptance evidence."),
    "manager": ("Supervisor", ["planning", "review"], ["engineering", "review"], "Coordinate bounded run tasks. Independently judge changes in a separate invocation. Owner grants, deterministic scheduling and policy remain authoritative."),
    "devops": ("DevOps", ["delivery"], [], "Inspect delivery preparation, registered verification and release constraints. Prepare evidence only; merge, deployment and policy changes require separate owner authority."),
    "ciso": ("CISO", ["security"], ["security"], "Independently inspect security evidence. Never waive blocking checks or alter security policy."),
}


def baseline(identifier):
    label, capabilities, skills, instruction = SPECIALISTS[identifier]
    return AgentDefinition(version=1, id=identifier, label=label, instructions=instruction,
        chains=[ChainDefinition(version=1, id=capability, steps=[ChainStep(version=1, id=capability, capability=capability)]) for capability in capabilities],
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
