"""Resolve launch-time choices without importing executable code from configuration."""

import json

import yaml
from pydantic import ValidationError

from sabre.credentials import model_secret_id
from sabre.flow_contracts import PHASE_ROLES, FlowConfiguration, Phase, ResolvedFlow, ResolvedPhase
from sabre.model_configuration import selection_updates
from sabre.models import DomainError
from sabre.repository import digest
from sabre.skills import DEFAULT_SKILLS, SKILLS


def parse_flow_yaml(document: str) -> FlowConfiguration:
    if len(document.encode()) > 65536:
        raise DomainError("FLOW_CONFIG_LIMIT", "Flow configuration exceeds 64 KiB", 422)

    class UniqueLoader(yaml.SafeLoader):
        def compose_node(self, parent, index):
            if self.check_event(yaml.AliasEvent):
                raise ValueError("YAML aliases are not supported")
            return super().compose_node(parent, index)

        def construct_mapping(self, node, deep=False):
            keys = [self.construct_object(key, deep=deep) for key, _ in node.value]
            if len(keys) != len(set(keys)):
                raise ValueError("Duplicate configuration key")
            return super().construct_mapping(node, deep=deep)

    try:
        raw = yaml.load(document, Loader=UniqueLoader)  # noqa: S506 - SafeLoader with stricter mappings
        return FlowConfiguration.model_validate(raw)
    except (yaml.YAMLError, ValueError, TypeError, RecursionError, ValidationError):
        raise DomainError("INVALID_FLOW_CONFIG", "Configuration must match the versioned flow schema; duplicate keys and aliases are rejected", 422) from None


async def resolve_flow(configuration, mode, models, credentials, definitions=None, model_snapshot=None) -> ResolvedFlow:
    from sabre.agent_catalog import ROLE_ADAPTERS
    revision, data = model_snapshot if model_snapshot is not None else await models.snapshot()
    cfg = models.configured(revision, data)
    approved = {data.default.destination, *(item.destination for item in data.roles.values() if item)}
    metadata = {item.id: item for item in await credentials.vault.list_metadata()}
    phases: dict[Phase, ResolvedPhase] = {}
    for phase, role in PHASE_ROLES.items():
        if definitions is None and phase in {"ux", "delivery_preparation"}:
            continue  # Historical callers retain their original phase set.
        if mode == "audit" and phase in {"ux", "delivery_preparation"}:
            continue
        if mode == "audit" and phase in {"design", "planning", "implementation"}:
            continue
        if mode != "create" and phase == "design":
            continue
        options = configuration.phases.get(phase)
        agent_id, _ = ROLE_ADAPTERS[role]
        definition = definitions.get(agent_id) if definitions else None
        authorization_role = {"designer": "architect", "devops": "qa"}.get(role, role)
        choice = configuration.phase_models.get(phase) or (options.model if options else None) or (definition.definition.model if definition else None) or data.roles[authorization_role] or data.default
        if choice.destination not in approved:
            raise DomainError("MODEL_DESTINATION_NOT_APPROVED", "Approve this model destination in Integrations before launching a flow", 403)
        selected = cfg.for_role(authorization_role).model_copy(update=selection_updates(choice))
        role_target, default_target = model_secret_id(selected, authorization_role), model_secret_id(selected)
        target = role_target if role_target in metadata else default_target
        if target and choice.provider != "local" and (target not in metadata or not metadata[target].configured):
            raise DomainError("MODEL_CREDENTIAL_MISSING", f"Configure credentials for the {phase} phase before launch", 409)
        if not choice.name:
            raise DomainError("MODEL_NAME_REQUIRED", f"Select an explicit model for the {phase} phase", 422)
        names = options.skills if options and options.skills else DEFAULT_SKILLS.get(phase, [])
        if definition and not (options and options.skills):
            names = [skill.name for skill in definition.definition.skills if authorization_role in SKILLS[skill.name].roles]
        if any(authorization_role not in SKILLS[name].roles for name in names):
            raise DomainError("SKILL_ROLE_MISMATCH", f"A selected skill does not apply to {phase}", 422)
        phases[phase] = ResolvedPhase(role=role, model=choice.model_copy(deep=True), credential_target=target,
                                     skills={name: SKILLS[name].digest for name in names}, definition=definition.model_copy(deep=True) if definition else None)
    material = {"configuration": configuration.model_dump(mode="json"), "mode": mode, "revision": revision,
                "phases": {key: value.model_dump(mode="json") for key, value in phases.items()}}
    return ResolvedFlow(model_revision=revision, phases=phases, configuration_digest=digest(material))


def phase_binding(work, role):
    if work.resolved_flow is None:
        return None
    phase = next((name for name, expected in PHASE_ROLES.items() if expected == role), None)
    binding = work.resolved_flow.phases.get(phase)
    if binding is None:
        raise DomainError("FLOW_PHASE_NOT_ALLOWED", "This flow does not authorize the requested agent phase", 403)
    for name, expected in binding.skills.items():
        if name not in SKILLS or SKILLS[name].digest != expected:
            raise DomainError("SKILL_VERSION_CHANGED", "Restore this run's skill version before resuming", 409)
    return binding


def flow_schema():
    return json.loads(json.dumps(FlowConfiguration.model_json_schema()))
