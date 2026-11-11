import type { ConfigurationView, FactoryConfiguration } from '../api';
import { configuration } from './modelConfigurationFixture';

export function factoryConfiguration(): ConfigurationView {
  const models = configuration();
  const value: FactoryConfiguration = {
    version: 1,
    models: {
      default: models.default,
      roles: Object.fromEntries(models.roles.map((role) => [role.role, role.override ?? null])),
    },
    flows: Object.fromEntries(
      ['patch', 'maintain', 'create', 'audit'].map((name) => [
        name,
        {
          version: 1 as const,
          phases: {},
          phase_models: {},
          permissions: { architecture: true, dependency_changes: false, draft_pull_request: true },
          repair_cycles: 2,
          budget_policy: null,
        },
      ]),
    ),
    policies: [
      {
        version: 1,
        id: 'commits',
        domain: 'delivery',
        mode: 'required',
        value: 'conventional',
        validator: 'conventional_commit',
      },
      {
        version: 1,
        id: 'branches',
        domain: 'delivery',
        mode: 'required',
        value: 'sabre_revision',
        validator: 'registered_branch',
      },
      {
        version: 1,
        id: 'verification',
        domain: 'security',
        mode: 'required',
        value: 'required',
        validator: 'registered_checks',
      },
      {
        version: 1,
        id: 'review',
        domain: 'security',
        mode: 'required',
        value: 'required',
        validator: 'independent_review',
      },
      {
        version: 1,
        id: 'publication',
        domain: 'delivery',
        mode: 'required',
        value: 'draft_only',
        validator: 'draft_pull_request',
      },
    ],
    context: { deduplicate: true, archive_reads: true, max_input_bytes: 98304 },
  };
  return {
    version: 1,
    revision: 0,
    configuration: value,
    yaml: JSON.stringify(value, null, 2),
    readiness: [
      {
        id: 'provider',
        status: 'ready',
        message: 'Synthetic provider session connected',
        action: 'Connect the selected official CLI session',
      },
      {
        id: 'model',
        status: models.default.name ? 'ready' : 'missing',
        message: models.default.name || 'Choose an explicit model',
        action: 'Choose an explicit model',
      },
      {
        id: 'project',
        status: 'ready',
        message: '1 registered project',
        action: 'Register executable checks',
      },
      {
        id: 'delivery',
        status: 'missing',
        message: 'Draft PR delivery requires a GitHub connection',
        action: 'Review repository permissions in Tools',
      },
    ],
  };
}
