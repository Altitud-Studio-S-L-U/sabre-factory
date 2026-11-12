import { useEffect, useState } from 'react';
import {
  type Api,
  type FlowConfiguration as Configuration,
  type ModelConfiguration,
  type ModelSelection,
  type AgentCatalogEntry,
} from './api';
import { SelectionFields } from './ModelConfiguration';
import Button from './components/Button';
import CheckField from './components/CheckField';
import Disclosure from './components/Disclosure';
import Notice from './components/Notice';
import Textarea from './components/Textarea';

const note = 'text-xs leading-relaxed text-muted-foreground';

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
    <fieldset className="grid min-w-0 gap-4 border-t border-border pt-5">
      <legend className="float-left mb-1 w-full text-base font-semibold">Flow configuration</legend>
      <p className="text-sm text-muted-foreground">
        Choose models before launch. Each run keeps its own configuration and skill versions.
      </p>
      {error && (
        <Notice tone="danger" role="alert">
          {error}
        </Notice>
      )}
      <ol className="flex flex-wrap gap-2" aria-label="Execution phases">
        {['Preflight', ...phases.map(([phase]) => phase), mode === 'audit' ? 'Report' : 'Draft PR'].map(
          (name) => (
            <li
              key={name}
              className="rounded-md border border-border bg-secondary px-2 py-1 text-xs text-muted-foreground capitalize"
            >
              {name}
            </li>
          ),
        )}
      </ol>
      {models && (
        <div className="grid min-w-0 divide-y divide-border border-y border-border">
          {phases.map(([phase, role]) => {
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
              <Disclosure
                key={phase}
                variant="plain"
                className="py-1.5"
                contentClassName="gap-3 pb-3"
                summary={
                  <span className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
                    <strong className="font-medium capitalize">{phase}</strong>
                    <span className="text-xs font-normal text-muted-foreground [overflow-wrap:anywhere]">
                      {selected?.provider || inherited.provider} ·{' '}
                      {selected?.name || inherited.name || 'Model required'}
                    </span>
                  </span>
                }
              >
                <p className={note}>
                  Model source: {origin}. Run phase → flow phase → published specialist → configured role →
                  factory default.
                </p>
                <CheckField
                  label="Override this phase for this run"
                  checked={Boolean(selected)}
                  onChange={(event) => updateModel(phase, event.target.checked ? { ...inherited } : null)}
                />
                {selected && (
                  <SelectionFields value={selected} onChange={(model) => updateModel(phase, model)} />
                )}
                <p className={note}>Destinations must already be approved in Integrations.</p>
              </Disclosure>
            );
          })}
        </div>
      )}
      <CheckField
        label="Allow dependency changes within this request"
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
      <Disclosure summary="Import YAML configuration" variant="plain" contentClassName="justify-items-start">
        <label className="grid w-full gap-1.5 text-sm font-medium">
          Versioned configuration
          <Textarea
            aria-label="Flow YAML"
            className="font-mono text-xs"
            value={yaml}
            rows={8}
            onChange={(event) => setYaml(event.target.value)}
            spellCheck={false}
          />
        </label>
        <Button
          variant="secondary"
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
        </Button>
      </Disclosure>
    </fieldset>
  );
}
