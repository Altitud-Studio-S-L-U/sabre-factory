import { useEffect, useState } from 'react';
import {
  type Api,
  type FlowConfiguration as Configuration,
  type ModelConfiguration,
  type ModelSelection,
} from './api';
import { SelectionFields } from './ModelConfiguration';
import './ExecutionTimeline.css';

const roles = {
  analysis: 'analyst',
  design: 'architect',
  planning: 'supervisor',
  implementation: 'developer',
  verification: 'qa',
  review: 'reviewer',
  security: 'security',
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
  const [error, setError] = useState('');
  const [yaml, setYaml] = useState('version: 1\nrepair_cycles: 2\n');
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    let active = true;
    api
      .modelConfiguration()
      .then((result) => {
        if (active) setModels(result);
      })
      .catch(() => {
        if (active) setError('Model configuration is unavailable. Refresh Integrations before launching.');
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
      ? !['design', 'planning', 'implementation'].includes(phase)
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
          const inherited =
            value.phases?.[phase]?.model ||
            models.roles.find((item) => item.role === role)?.effective ||
            models.default;
          const selected = value.phase_models?.[phase];
          return (
            <details className="phase-configuration" key={phase}>
              <summary>
                <strong>{phase}</strong>
                <span>
                  {selected?.provider || inherited.provider} ·{' '}
                  {selected?.name || inherited.name || 'Model required'}
                </span>
              </summary>
              <label className="inline-check">
                <input
                  type="checkbox"
                  checked={Boolean(selected)}
                  onChange={(event) => updateModel(phase, event.target.checked ? { ...inherited } : null)}
                />
                Override this phase for this run
              </label>
              {selected && (
                <SelectionFields
                  value={selected as ModelSelection}
                  onChange={(model) => updateModel(phase, model)}
                />
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
