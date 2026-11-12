import { useEffect, useState } from 'react';
import {
  type Api,
  type FlowConfiguration as Configuration,
  type ModelConfiguration,
  type ModelSelection,
  type AgentCatalogEntry,
} from './api';
import { SelectionFields } from './ModelConfiguration';
import './ExecutionTimeline.css';

const roles = {
  analysis: 'analyst',
  ux: 'designer',
  design: 'architect',
  planning: 'supervisor',
  implementation: 'developer',
  verification: 'qa',
  review: 'reviewer',
  security: 'security',
  delivery_preparation: 'devops',
} as const;

export default function FlowConfiguration({
  api,
  mode,
  value,
  onChange,
}: {
  api: Api;
  mode: string;
  value: Configuration;
  onChange: (value: Configuration) => void;
}) {
  const [models, setModels] = useState<ModelConfiguration | null>(null);
  const [specialists, setSpecialists] = useState<AgentCatalogEntry[]>([]);
  const [error, setError] = useState('');
  const [yaml, setYaml] = useState('version: 1\nrepair_cycles: 2\n');
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    let active = true;
    Promise.all([api.modelConfiguration(), api.agents()])
      .then(([result, catalog]) => {
        if (active) {
          setModels(result);
          setSpecialists(catalog.agents);
        }
      })
      .catch(() => {
        if (active)
          setError(
            'Model and published specialist configuration is unavailable. Refresh Config and Agents before launching.',
          );
      });
    return () => {
      active = false;
    };
  }, [api]);
  const updateModel = (phase: string, model: ModelSelection | null) => {
    const phase_models = { ...value.phase_models };
    if (model) phase_models[phase] = model;
    else delete phase_models[phase];
    onChange({ ...value, phase_models });
  };
  const phases = Object.entries(roles).filter(([phase]) =>
    mode === 'audit'
      ? !['design', 'ux', 'planning', 'implementation', 'delivery_preparation'].includes(phase)
      : mode === 'create' || phase !== 'design',
  );
  return (
    <fieldset className="flow-configuration">
      <legend>Flow configuration</legend>
      <p>Choose models before launch. Each run keeps its own configuration and skill versions.</p>
      {error && <p role="alert">{error}</p>}
      <ol className="flow-preview" aria-label="Execution phases">
        <li>Preflight</li>
        {phases.map(([phase]) => (
          <li key={phase}>{phase}</li>
        ))}
        <li>{mode === 'audit' ? 'Report' : 'Draft PR'}</li>
      </ol>
      {models &&
        phases.map(([phase, role]) => {
          const specialist = specialists.find((entry) => entry.legacy_roles.includes(role));
          const authorizationRole = role === 'designer' ? 'architect' : role === 'devops' ? 'qa' : role;
          const legacy = models.roles.find((item) => item.role === authorizationRole);
          const flowModel = value.phases?.[phase]?.model;
          const publishedModel = specialist?.published.definition.model;
          const inherited = flowModel ?? publishedModel ?? legacy?.effective ?? models.default;
          const selected = value.phase_models?.[phase];
          const origin = selected
            ? 'Run phase override'
            : flowModel
              ? 'Flow phase override'
              : publishedModel
                ? `Published ${specialist.label} · version ${specialist.published.version}`
                : legacy?.override
                  ? `Configured ${authorizationRole} role`
                  : 'Factory default';
          return (
            <details className="phase-configuration" key={phase}>
              <summary>
                <strong>{phase}</strong>
                <span>
                  {selected?.provider || inherited.provider} ·{' '}
                  {selected?.name || inherited.name || 'Model required'}
                </span>
              </summary>
              <p className="hint">
                Model source: {origin}. Run phase → flow phase → published specialist → configured role →
                factory default.
              </p>
              <label className="inline-check">
                <input
                  type="checkbox"
                  checked={Boolean(selected)}
                  onChange={(event) => updateModel(phase, event.target.checked ? { ...inherited } : null)}
                />
                Override this phase for this run
              </label>
              {selected && (
                <SelectionFields value={selected} onChange={(model) => updateModel(phase, model)} />
              )}
              <p className="hint">Destinations must already be approved in Integrations.</p>
            </details>
          );
        })}
      <label className="inline-check">
        <input
          type="checkbox"
          checked={value.permissions?.dependency_changes ?? false}
          onChange={(event) =>
            onChange({
              ...value,
              permissions: {
                architecture: true,
                draft_pull_request: true,
                ...value.permissions,
                dependency_changes: event.target.checked,
              },
            })
          }
        />
        Allow dependency changes within this request
      </label>
      <details className="phase-configuration">
        <summary>Import YAML configuration</summary>
        <label>
          Versioned configuration
          <textarea
            aria-label="Flow YAML"
            value={yaml}
            rows={8}
            onChange={(event) => setYaml(event.target.value)}
            spellCheck={false}
          />
        </label>
        <button
          className="button"
          type="button"
          disabled={loading}
          onClick={async () => {
            setLoading(true);
            setError('');
            try {
              onChange(await api.parseFlow(yaml));
            } catch {
              setError('Invalid YAML configuration. Check the schema, types and duplicate keys.');
            } finally {
              setLoading(false);
            }
          }}
        >
          {loading ? 'Validating…' : 'Apply configuration'}
        </button>
      </details>
    </fieldset>
  );
}
