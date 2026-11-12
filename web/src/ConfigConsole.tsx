import Button from './components/Button';
import Input from './components/Input';
import Textarea from './components/Textarea';
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router';
import {
  ApiError,
  type Api,
  type ConfigurationView,
  type FactoryConfiguration,
  type ConfigurationPreview,
  type ModelConfiguration,
  type ModelSelection,
  type Project,
  type SecretMetadata,
} from './api';
import { providers, SelectionFields } from './ModelConfiguration';
import Credentials from './Credentials';
import Dialog from './components/Dialog';
import Field from './components/FormField';
import Select from './components/Select';
import BudgetFields, { defaultBudgetPolicy } from './components/BudgetFields';
import './ConsoleSections.css';

const failure = (reason: unknown) =>
  reason instanceof ApiError
    ? reason.message
    : 'The configuration request could not be confirmed. Your draft is retained.';
const roleNames: Record<string, string> = {
  supervisor: 'Supervisor',
  analyst: 'Analyst',
  architect: 'Architect',
  developer: 'Developer',
  qa: 'QA',
  reviewer: 'Reviewer',
  security: 'Security',
};
const phaseNames = [
  'analysis',
  'design',
  'planning',
  'implementation',
  'verification',
  'review',
  'security',
] as const;
const skills = ['engineering', 'verification', 'review', 'security'] as const;
const encode = (value: FactoryConfiguration) => JSON.stringify(value, null, 2);
export interface ConfigConsoleProps {
  api: Api;
  projects: Project[];
  connected?: boolean;
  onRefresh?: () => Promise<void>;
  onError?: (message: string) => void;
}

export default function ConfigConsole({ api, projects, connected = true, onRefresh }: ConfigConsoleProps) {
  const [saved, setSaved] = useState<ConfigurationView | null>(null);
  const [draft, setDraft] = useState<FactoryConfiguration | null>(null);
  const [document, setDocument] = useState('');
  const [mode, setMode] = useState('Guided setup');
  const [step, setStep] = useState(() =>
    new URLSearchParams(window.location.search).get('section') === 'models' ? 1 : 0,
  );
  const [flow, setFlow] = useState<'patch' | 'maintain' | 'create' | 'audit'>('patch');
  const [runners, setRunners] = useState<ModelConfiguration['runners']>([]);
  const [modelIntegrations, setModelIntegrations] = useState<Awaited<ReturnType<Api['integrations']>>>([]);
  const [credentialMetadata, setCredentialMetadata] = useState<SecretMetadata[] | null>(null);
  const [preview, setPreview] = useState<ConfigurationPreview | null>(null);
  const [validatedDocument, setValidatedDocument] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [approved, setApproved] = useState(false);
  const [role, setRole] = useState<string | null>(null);
  const [credentialIds, setCredentialIds] = useState<string[] | null>(null);
  const [newPreference, setNewPreference] = useState(false);
  const [preference, setPreference] = useState({
    id: '',
    domain: 'ui' as 'ui' | 'architecture' | 'infrastructure' | 'delivery' | 'security',
    value: '',
  });
  const accept = (value: ConfigurationView) => {
    setSaved(value);
    setDraft(value.configuration);
    setDocument(value.yaml);
    setPreview(null);
    setValidatedDocument('');
    setApproved(false);
  };
  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [configuration, models, integrations, metadata] = await Promise.all([
        api.configuration(),
        api.modelConfiguration(),
        api.integrations(),
        api.secrets().catch(() => null),
      ]);
      accept(configuration);
      setRunners(models.runners);
      setModelIntegrations(integrations.filter((item) => item.kind === 'model'));
      setCredentialMetadata(metadata);
    } catch (reason) {
      setError(failure(reason));
    } finally {
      setLoading(false);
    }
  }, [api]);
  useEffect(() => {
    void load();
  }, [load]);
  const dirty =
    !!saved &&
    !!draft &&
    (mode === 'YAML / JSON'
      ? document !== saved.yaml && document !== encode(saved.configuration)
      : encode(draft) !== encode(saved.configuration));
  const update = (value: FactoryConfiguration) => {
    setDraft(value);
    setDocument(encode(value));
    setPreview(null);
    setValidatedDocument('');
    setApproved(false);
    setNotice('');
  };
  const changeDefault = (value: ModelSelection) => {
    if (draft) update({ ...draft, models: { ...draft.models, default: value } });
  };
  const validate = async (target = document) => {
    if (busy || !connected) return;
    setBusy(true);
    setError('');
    setNotice('');
    setApproved(false);
    try {
      const result = await api.previewConfiguration(target);
      setPreview(result);
      setValidatedDocument(result.valid ? target : '');
      if (result.valid && result.configuration) setDraft(result.configuration);
    } catch (reason) {
      setError(failure(reason));
    } finally {
      setBusy(false);
    }
  };
  const save = async () => {
    if (
      !saved ||
      !draft ||
      !preview?.valid ||
      validatedDocument !== document ||
      !approved ||
      busy ||
      !connected
    )
      return;
    setBusy(true);
    setError('');
    try {
      const destinations = [
        ...new Set([
          draft.models.default.destination,
          ...Object.values(draft.models.roles)
            .filter((value): value is ModelSelection => !!value)
            .map((value) => value.destination),
        ]),
      ].sort();
      accept(
        await api.saveConfiguration({
          version: 1,
          expected_revision: saved.revision,
          document,
          approved_destinations: destinations,
        }),
      );
      setNotice('Configuration saved for future runs. Active runs retain their pinned settings.');
      try {
        await onRefresh?.();
      } catch {
        setError('Configuration was saved. Overall status could not be refreshed; refresh before launching.');
      }
    } catch (reason) {
      setError(failure(reason));
    } finally {
      setBusy(false);
    }
  };
  const switchMode = async (next: string) => {
    if (next === mode) return;
    if (!connected && mode === 'YAML / JSON' && next !== mode) {
      setError(
        'Reconnect to validate the document before returning to guided editing. Your document is retained.',
      );
      return;
    }
    if (mode === 'YAML / JSON' && next !== 'YAML / JSON' && document !== validatedDocument) {
      setBusy(true);
      setError('');
      try {
        const result = await api.previewConfiguration(document);
        setPreview(result);
        if (!result.valid || !result.configuration) return;
        setDraft(result.configuration);
        setValidatedDocument(document);
        setMode(next);
      } catch (reason) {
        setError(failure(reason));
      } finally {
        setBusy(false);
      }
    } else setMode(next);
  };
  const selection = draft?.models.default;
  const cli = selection?.provider === 'codex_cli' || selection?.provider === 'claude_cli';
  const runner = runners.find((item) => item.provider === selection?.provider);
  const providerIntegration = modelIntegrations.find((item) => item.kind === 'model');
  const providerTargetIds =
    providerIntegration?.credential_ids.filter(
      (id) =>
        id.startsWith(`model.${selection?.provider}.`) &&
        id.endsWith('.default') &&
        (selection?.provider !== 'local' ||
          selection.destination === saved?.configuration.models.default.destination),
    ) ?? [];
  const providerConfigured = providerTargetIds.some((id) =>
    credentialMetadata?.some((item) => item.id === id && item.configured),
  );
  const destinations = draft
    ? [
        ...new Set([
          draft.models.default.destination,
          ...Object.values(draft.models.roles)
            .filter((value): value is ModelSelection => !!value)
            .map((value) => value.destination),
        ]),
      ].sort()
    : [];
  return (
    <div className="operator-page">
      <header className="operator-heading">
        <div>
          <span className="operator-eyebrow">Factory settings</span>
          <h1>Config</h1>
          <p>
            Connect a provider, select an explicit model and review project readiness. Guided editing and YAML
            share one validated contract.
          </p>
        </div>
        <div className="operator-actions">
          <span className="operator-tag">
            {saved ? `Revision ${saved.revision}` : 'Loading configuration'}
          </span>
          <Button className="button" disabled={loading || busy || dirty} onClick={() => void load()}>
            Refresh
          </Button>
        </div>
      </header>
      {!connected && (
        <p className="notice warning" role="status">
          Disconnected. Draft edits stay in this view; validation and saving require reconnection.
        </p>
      )}
      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="notice neutral" role="status">
          {notice}
        </p>
      )}
      {loading && !draft && (
        <div className="operator-panel" role="status">
          Loading the effective configuration…
        </div>
      )}
      {draft && saved && selection && (
        <>
          <div className="operator-tabs" aria-label="Configuration views">
            {['Guided setup', 'YAML / JSON', 'Policies & limits', 'Context & storage'].map((name) => (
              <Button
                key={name}
                disabled={busy}
                aria-pressed={mode === name}
                onClick={() => void switchMode(name)}
              >
                {name}
              </Button>
            ))}
          </div>
          {mode === 'Guided setup' && (
            <>
              <div className="operator-steps" aria-label="Setup steps">
                {['Connect provider', 'Choose model', 'Connect project', 'Review readiness'].map(
                  (name, index) => (
                    <Button key={name} aria-pressed={step === index} onClick={() => setStep(index)}>
                      {String(index + 1).padStart(2, '0')} · {name}
                    </Button>
                  ),
                )}
              </div>
              <div className="operator-split">
                <section className="operator-panel">
                  <span className="operator-eyebrow">Step {step + 1} of 4</span>
                  {step === 0 && (
                    <>
                      <h2 style={{ marginTop: 10 }}>Connect a model provider</h2>
                      <p className="muted">
                        Choose how specialists access the model. Each method retains its own authentication
                        and destination.
                      </p>
                      <Field label="Model provider">
                        <Select
                          value={selection.provider}
                          onChange={(event) => {
                            const provider = event.target.value as ModelSelection['provider'];
                            changeDefault({
                              ...selection,
                              provider,
                              name: '',
                              destination: providers[provider].destination,
                              input_usd_per_million: 0,
                              output_usd_per_million: 0,
                            });
                          }}
                        >
                          <optgroup label="Recommended connection methods">
                            {['codex_cli', 'claude_cli', 'openai', 'anthropic'].map((id) => (
                              <option key={id} value={id}>
                                {providers[id as ModelSelection['provider']].title}
                              </option>
                            ))}
                          </optgroup>
                          <optgroup label="Advanced adapters">
                            <option value="google">Google · API</option>
                            <option value="local">Compatible endpoint</option>
                          </optgroup>
                        </Select>
                      </Field>
                      <div className="operator-section-divider">
                        <h3>{cli ? 'Official account session' : 'Destination-scoped API credential'}</h3>
                        <p>
                          {cli
                            ? 'Connect the dedicated factory runner from your own terminal using the official CLI login. Your everyday CLI session is not imported.'
                            : 'Store a write-only credential for the registered destination. Its value is never included in this document or its exports.'}
                        </p>
                        <span
                          className={`operator-tag ${cli ? (runner?.authenticated ? 'good' : 'warning') : providerConfigured ? 'good' : 'warning'}`}
                        >
                          {cli
                            ? runner?.busy
                              ? 'Runner busy · session not checked'
                              : !runner?.available
                                ? 'Runner unavailable'
                                : runner.authenticated
                                  ? 'Session connected'
                                  : 'Session connection required'
                            : providerTargetIds.length === 0
                              ? 'Save the provider selection to register its credential destination'
                              : credentialMetadata === null
                                ? 'Credential metadata unavailable'
                                : providerConfigured
                                  ? 'Credential present · validity not checked'
                                  : 'Credential not configured'}
                        </span>
                        {cli && (
                          <p className="operator-readonly">
                            In the SABRE terminal:{' '}
                            <code>
                              node infra/ops.mjs{' '}
                              {selection.provider === 'claude_cli' ? 'claude-login' : 'codex-login'}
                            </code>
                          </p>
                        )}
                        {!cli && providerTargetIds.length ? (
                          <p>
                            <Button
                              className="button"
                              onClick={() => setCredentialIds(providerTargetIds)}
                              disabled={!connected}
                            >
                              Manage provider credential
                            </Button>
                          </p>
                        ) : null}
                      </div>
                      <p className="notice neutral">
                        Context destination:{' '}
                        <code>{selection.destination || 'Explicit endpoint required'}</code>.{' '}
                        {cli
                          ? 'Subscription limits are managed by the provider.'
                          : 'API spend requires separate run authorization.'}
                      </p>
                      <Button className="button primary" onClick={() => setStep(1)}>
                        Continue to model
                      </Button>
                    </>
                  )}
                  {step === 1 && (
                    <>
                      <h2 style={{ marginTop: 10 }}>Choose the default model</h2>
                      <p className="muted">
                        Use one explicit model for the team, then override only the specialists that need a
                        different selection.
                      </p>
                      <Field
                        label="Model identifier"
                        hint="Use an identifier available to your provider account. Saving a name does not prove model availability."
                      >
                        <Input
                          required
                          value={selection.name}
                          maxLength={128}
                          pattern={'[A-Za-z0-9._:\\/\\-]+'}
                          onChange={(event) => changeDefault({ ...selection, name: event.target.value })}
                        />
                      </Field>
                      <p>
                        Provider: <strong>{providers[selection.provider].title}</strong>
                      </p>
                      <details className="operator-section-divider">
                        <summary>Advanced model settings</summary>
                        <div style={{ marginTop: 18 }}>
                          <Field label="Destination">
                            <Input
                              type="url"
                              readOnly={selection.provider !== 'local'}
                              value={selection.destination}
                              onChange={(event) =>
                                changeDefault({ ...selection, destination: event.target.value })
                              }
                            />
                          </Field>
                          <Field label="Maximum output tokens">
                            <Input
                              type="number"
                              min={128}
                              max={32768}
                              value={selection.max_output_tokens}
                              onChange={(event) =>
                                changeDefault({ ...selection, max_output_tokens: Number(event.target.value) })
                              }
                            />
                          </Field>
                          {!cli && (
                            <div className="operator-two">
                              <Field label="USD per million input tokens">
                                <Input
                                  type="number"
                                  min={0}
                                  step="any"
                                  value={selection.input_usd_per_million}
                                  onChange={(event) =>
                                    changeDefault({
                                      ...selection,
                                      input_usd_per_million: Number(event.target.value),
                                    })
                                  }
                                />
                              </Field>
                              <Field label="USD per million output tokens">
                                <Input
                                  type="number"
                                  min={0}
                                  step="any"
                                  value={selection.output_usd_per_million}
                                  onChange={(event) =>
                                    changeDefault({
                                      ...selection,
                                      output_usd_per_million: Number(event.target.value),
                                    })
                                  }
                                />
                              </Field>
                            </div>
                          )}
                        </div>
                      </details>
                      <details className="operator-section-divider">
                        <summary>Specialist overrides</summary>
                        <ul className="operator-checks">
                          {Object.entries(draft.models.roles).map(([name, value]) => (
                            <li key={name}>
                              <div>
                                {roleNames[name] ?? name}
                                <small>
                                  {value
                                    ? `${providers[value.provider].title} · ${value.name || 'Model required'}`
                                    : `Inherits default · ${selection.name || 'Model required'}`}
                                </small>
                              </div>
                              <Button className="button small" onClick={() => setRole(name)}>
                                Edit
                              </Button>
                            </li>
                          ))}
                        </ul>
                      </details>
                      <Button
                        className="button primary"
                        style={{ marginTop: 20 }}
                        disabled={!selection.name.trim()}
                        onClick={() => setStep(2)}
                      >
                        Continue to project
                      </Button>
                    </>
                  )}
                  {step === 2 && (
                    <>
                      <h2 style={{ marginTop: 10 }}>Connect a project</h2>
                      <p className="muted">
                        GitHub supplies source access and draft PR delivery. Read, publish and repository
                        creation use separate scoped credentials.
                      </p>
                      {projects.length ? (
                        <ul className="operator-checks">
                          {projects.map((project) => (
                            <li key={project.id}>
                              <div>
                                <strong>{project.name}</strong>
                                <small>{project.repository}</small>
                                <small>
                                  {project.profile} · {project.gate_commands.length} configured checks ·{' '}
                                  {project.default_branch}
                                </small>
                              </div>
                              <span className="operator-tag">Registered</span>
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <p className="notice warning">
                          No project is registered. Add a repository from the project selector or browse
                          GitHub in Tools.
                        </p>
                      )}
                      <p className="operator-readonly">
                        Repository permissions and executable checks are checked at launch. A saved credential
                        alone does not establish readiness.
                      </p>
                      <div className="operator-actions">
                        <Link className="button" to="/tools">
                          Manage repository access
                        </Link>
                        <Button className="button primary" onClick={() => setStep(3)}>
                          Review readiness
                        </Button>
                      </div>
                    </>
                  )}
                  {step === 3 && (
                    <>
                      <h2 style={{ marginTop: 10 }}>Review readiness</h2>
                      <p className="muted">
                        These checks describe the saved revision. Draft changes must be validated and saved
                        before they affect future runs.
                      </p>
                      <ul className="operator-checks">
                        {saved.readiness.map((item) => (
                          <li key={item.id}>
                            <div>
                              {item.message}
                              <small>{item.action}</small>
                            </div>
                            <span className={`operator-tag ${item.status === 'ready' ? 'good' : 'warning'}`}>
                              {item.status === 'ready'
                                ? 'Configured'
                                : item.status === 'unavailable'
                                  ? 'Unavailable'
                                  : 'Action needed'}
                            </span>
                          </li>
                        ))}
                      </ul>
                      <p className="notice neutral">
                        Connection, explicit model, repository access and delivery authorization are separate.
                        Final model and permission checks run before dispatch.
                      </p>
                    </>
                  )}
                </section>
                <aside className="operator-panel operator-sticky">
                  <span className="operator-eyebrow">Effective draft</span>
                  <h2 style={{ marginTop: 12 }}>What the factory will use</h2>
                  <dl className="operator-kv">
                    <dt>Provider</dt>
                    <dd>{providers[selection.provider].title}</dd>
                    <dt>Model</dt>
                    <dd>{selection.name || 'Not selected'}</dd>
                    <dt>Team</dt>
                    <dd>
                      {Object.values(draft.models.roles).filter(Boolean).length} overrides ·{' '}
                      {Object.values(draft.models.roles).filter((value) => !value).length} inherited
                    </dd>
                    <dt>Routing order</dt>
                    <dd>Run phase → flow phase → specialist → default</dd>
                    <dt>Source</dt>
                    <dd>{dirty ? 'Unsaved draft' : `Saved revision ${saved.revision}`}</dd>
                    <dt>Permissions</dt>
                    <dd>Resolved and pinned at launch</dd>
                  </dl>
                  <details>
                    <summary>View secret-free contract</summary>
                    <pre className="operator-code">{encode(draft)}</pre>
                  </details>
                  <p className="operator-readonly">
                    Saving configuration never starts a run or publishes repository changes.
                  </p>
                </aside>
              </div>
            </>
          )}
          {mode === 'YAML / JSON' && (
            <section className="operator-panel">
              <h2>Versioned configuration contract</h2>
              <p className="muted">
                The server validates YAML and JSON against the same schema as guided setup. Aliases, duplicate
                keys, unknown capabilities and input over 64 KiB are rejected.
              </p>
              <Field label="Configuration document">
                <Textarea
                  value={document}
                  maxLength={65536}
                  rows={24}
                  spellCheck={false}
                  style={{ fontFamily: 'Consolas,monospace', fontSize: 12 }}
                  onChange={(event) => {
                    setDocument(event.target.value);
                    setPreview(null);
                    setApproved(false);
                  }}
                />
              </Field>
              <Button
                className="button"
                disabled={
                  document !== saved.yaml &&
                  !(preview?.valid && preview.yaml && validatedDocument === document)
                }
                onClick={() => {
                  const exportDocument =
                    preview?.valid && validatedDocument === document ? preview.yaml : saved.yaml;
                  if (!exportDocument) return;
                  const url = URL.createObjectURL(new Blob([exportDocument], { type: 'application/yaml' }));
                  const link = window.document.createElement('a');
                  link.href = url;
                  link.download = 'sabre-configuration.yaml';
                  link.click();
                  URL.revokeObjectURL(url);
                }}
              >
                Download document
              </Button>
              <p className="operator-readonly">
                Exports use the saved or server-validated secret-free contract. Validate draft edits before
                downloading.
              </p>
            </section>
          )}
          {mode === 'Policies & limits' && (
            <>
              <section className="operator-panel">
                <div className="operator-heading">
                  <div>
                    <h2>Policy domains</h2>
                    <p>
                      Required rules use registered validators. Preferences guide work and require human
                      review.
                    </p>
                  </div>
                  <Button className="button" onClick={() => setNewPreference(true)}>
                    Add preference
                  </Button>
                </div>
                <ul className="operator-checks">
                  {draft.policies.map((policy, index) => (
                    <li key={policy.id}>
                      <div style={{ flex: 1 }}>
                        <strong>{policy.id}</strong>
                        <small>
                          {policy.domain} ·{' '}
                          {policy.mode === 'required'
                            ? `Validator: ${policy.validator}`
                            : 'Advisory · human review'}{' '}
                          · version {policy.version} · factory contract
                        </small>
                        {policy.mode === 'required' ? (
                          <p>{policy.value}</p>
                        ) : (
                          <Textarea
                            aria-label={`Preference ${policy.id}`}
                            value={policy.value}
                            maxLength={4000}
                            rows={2}
                            style={{ marginTop: 10 }}
                            onChange={(event) =>
                              update({
                                ...draft,
                                policies: draft.policies.map((item, position) =>
                                  position === index ? { ...item, value: event.target.value } : item,
                                ),
                              })
                            }
                          />
                        )}
                      </div>
                      <span className={`operator-tag ${policy.mode === 'required' ? 'warning' : ''}`}>
                        {policy.mode === 'required' ? 'Required' : 'Preference'}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
              <section className="operator-panel">
                <h2>Flow defaults</h2>
                <p className="muted">
                  Choose a registered flow, then refine permissions and phase overrides. Runs pin the resolved
                  configuration.
                </p>
                <Field label="Flow">
                  <Select value={flow} onChange={(event) => setFlow(event.target.value as typeof flow)}>
                    {['patch', 'maintain', 'create', 'audit'].map((name) => (
                      <option key={name} value={name}>
                        {name}
                      </option>
                    ))}
                  </Select>
                </Field>
                <div className="operator-two">
                  {!draft.flows[flow].budget_policy && (
                    <Field
                      label="Repair cycles"
                      hint="Legacy bounded flow limit. Enable a versioned budget policy to configure cumulative bounds and reserve."
                    >
                      <Input
                        type="number"
                        min={0}
                        max={2}
                        value={draft.flows[flow].repair_cycles}
                        onChange={(event) =>
                          update({
                            ...draft,
                            flows: {
                              ...draft.flows,
                              [flow]: { ...draft.flows[flow], repair_cycles: Number(event.target.value) },
                            },
                          })
                        }
                      />
                    </Field>
                  )}
                  <div>
                    <p>Flow permissions</p>
                    {(['architecture', 'dependency_changes', 'draft_pull_request'] as const).map((name) => (
                      <label className="check-line" key={name}>
                        <Input
                          type="checkbox"
                          checked={draft.flows[flow].permissions?.[name] ?? name !== 'dependency_changes'}
                          onChange={(event) =>
                            update({
                              ...draft,
                              flows: {
                                ...draft.flows,
                                [flow]: {
                                  ...draft.flows[flow],
                                  permissions: {
                                    ...draft.flows[flow].permissions,
                                    [name]: event.target.checked,
                                  },
                                },
                              },
                            })
                          }
                        />
                        {name.replaceAll('_', ' ')}
                      </label>
                    ))}
                  </div>
                </div>
                <details className="operator-section-divider">
                  <summary>Run budgets and recovery</summary>
                  <label className="check-line" style={{ marginTop: 18 }}>
                    <Input
                      type="checkbox"
                      checked={!!draft.flows[flow].budget_policy}
                      onChange={(event) =>
                        update({
                          ...draft,
                          flows: {
                            ...draft.flows,
                            [flow]: {
                              ...draft.flows[flow],
                              budget_policy: event.target.checked
                                ? {
                                    ...defaultBudgetPolicy,
                                    repairs: {
                                      primary: draft.flows[flow].repair_cycles,
                                      reserve: 0,
                                      absolute: draft.flows[flow].repair_cycles,
                                    },
                                  }
                                : null,
                            },
                          },
                        })
                      }
                    />
                    Use a versioned budget policy for this flow
                  </label>
                  {draft.flows[flow].budget_policy ? (
                    <BudgetFields
                      value={draft.flows[flow].budget_policy!}
                      onChange={(value) =>
                        update({
                          ...draft,
                          flows: { ...draft.flows, [flow]: { ...draft.flows[flow], budget_policy: value } },
                        })
                      }
                    />
                  ) : (
                    <p className="operator-readonly">
                      This flow keeps its existing launch-budget behavior until an explicit policy is
                      selected.
                    </p>
                  )}
                </details>
                <details className="operator-section-divider">
                  <summary>Advanced phase models and skills</summary>
                  {phaseNames
                    .filter((phase) =>
                      flow === 'audit'
                        ? !['design', 'planning', 'implementation'].includes(phase)
                        : flow === 'create' || phase !== 'design',
                    )
                    .map((phase) => {
                      const phaseValue = draft.flows[flow].phases?.[phase];
                      const override = draft.flows[flow].phase_models?.[phase];
                      return (
                        <details
                          key={phase}
                          style={{ padding: '16px 0', borderBottom: '1px solid var(--line)' }}
                        >
                          <summary>
                            {phase} ·{' '}
                            {override?.name || phaseValue?.model?.name || 'inherits specialist/default'}
                          </summary>
                          <div style={{ marginTop: 16 }}>
                            <label className="check-line">
                              <Input
                                type="checkbox"
                                checked={!!override}
                                onChange={(event) => {
                                  const phase_models = { ...draft.flows[flow].phase_models };
                                  if (event.target.checked) phase_models[phase] = { ...selection };
                                  else delete phase_models[phase];
                                  update({
                                    ...draft,
                                    flows: { ...draft.flows, [flow]: { ...draft.flows[flow], phase_models } },
                                  });
                                }}
                              />
                              Override model for this flow phase
                            </label>
                            {override && (
                              <SelectionFields
                                value={override}
                                onChange={(value) =>
                                  update({
                                    ...draft,
                                    flows: {
                                      ...draft.flows,
                                      [flow]: {
                                        ...draft.flows[flow],
                                        phase_models: { ...draft.flows[flow].phase_models, [phase]: value },
                                      },
                                    },
                                  })
                                }
                              />
                            )}
                            <fieldset>
                              <legend>Registered skills</legend>
                              {skills.map((skill) => (
                                <label className="check-line" key={skill}>
                                  <Input
                                    type="checkbox"
                                    checked={phaseValue?.skills?.includes(skill) ?? false}
                                    onChange={(event) => {
                                      const selectedSkills = phaseValue?.skills ?? [];
                                      const nextSkills = event.target.checked
                                        ? [...selectedSkills, skill]
                                        : selectedSkills.filter((item) => item !== skill);
                                      update({
                                        ...draft,
                                        flows: {
                                          ...draft.flows,
                                          [flow]: {
                                            ...draft.flows[flow],
                                            phases: {
                                              ...draft.flows[flow].phases,
                                              [phase]: { ...phaseValue, skills: nextSkills },
                                            },
                                          },
                                        },
                                      });
                                    }}
                                  />
                                  {skill}
                                </label>
                              ))}
                            </fieldset>
                          </div>
                        </details>
                      );
                    })}
                </details>
              </section>
            </>
          )}
          {mode === 'Context & storage' && (
            <div className="operator-two">
              <section className="operator-panel">
                <h2>Context preparation</h2>
                <p>
                  Bound input and preserve source references. Context settings cannot grant execution
                  permissions.
                </p>
                <label className="check-line">
                  <Input
                    type="checkbox"
                    checked={draft.context.deduplicate}
                    onChange={(event) =>
                      update({ ...draft, context: { ...draft.context, deduplicate: event.target.checked } })
                    }
                  />
                  Deduplicate repeated context
                </label>
                <label className="check-line">
                  <Input
                    type="checkbox"
                    checked={draft.context.archive_reads}
                    onChange={(event) =>
                      update({ ...draft, context: { ...draft.context, archive_reads: event.target.checked } })
                    }
                  />
                  Archive recorded source reads
                </label>
                <Field
                  label="Maximum input bytes"
                  hint="Between 4,096 and 98,304 bytes. Retrieval remains project scoped."
                >
                  <Input
                    type="number"
                    min={4096}
                    max={98304}
                    value={draft.context.max_input_bytes}
                    onChange={(event) =>
                      update({
                        ...draft,
                        context: { ...draft.context, max_input_bytes: Number(event.target.value) },
                      })
                    }
                  />
                </Field>
              </section>
              <section className="operator-panel">
                <h2>Storage and provenance</h2>
                <dl className="operator-kv">
                  <dt>Persistent store</dt>
                  <dd>PostgreSQL</dd>
                  <dt>Source navigation</dt>
                  <dd>Project-scoped text search</dd>
                  <dt>Semantic retrieval</dt>
                  <dd>Optional provider; inspect each project in Memory</dd>
                  <dt>Credentials</dt>
                  <dd>Encrypted, write-only and destination scoped</dd>
                </dl>
                <p className="muted">
                  The active storage system is managed by the instance. No migration or database change is
                  performed by this form.
                </p>
              </section>
            </div>
          )}
          <section className="operator-panel">
            <h2>Validate and review</h2>
            <p className="muted">
              Preview the server-resolved contract and changed fields before saving. Validation does not run
              agents, grant permissions or publish.
            </p>
            <div className="operator-actions">
              <Button
                className="button primary"
                disabled={busy || !connected}
                onClick={() => void validate()}
              >
                {busy ? 'Checking…' : 'Validate & preview'}
              </Button>
              {dirty && (
                <Button className="button" disabled={busy} onClick={() => accept(saved)}>
                  Discard draft
                </Button>
              )}
            </div>
            {preview && (
              <div className="operator-section-divider">
                <span className={`operator-tag ${preview.valid ? 'good' : 'warning'}`}>
                  {preview.valid ? 'Schema validated' : 'Changes required'}
                </span>
                {preview.diagnostics.length > 0 && (
                  <ul role="alert">
                    {preview.diagnostics.map((item, index) => (
                      <li key={`${item.path}-${index}`}>
                        <code>{item.path}</code>: {item.message}
                      </li>
                    ))}
                  </ul>
                )}
                {preview.valid && (
                  <>
                    {preview.safe_diff.length ? (
                      <div className="operator-table-wrap" style={{ marginTop: 18 }}>
                        <table className="operator-table">
                          <thead>
                            <tr>
                              <th>Field</th>
                              <th>Saved value</th>
                              <th>Proposed value</th>
                            </tr>
                          </thead>
                          <tbody>
                            {preview.safe_diff.map((change) => (
                              <tr key={change.path}>
                                <td>
                                  <code>{change.path}</code>
                                </td>
                                <td>
                                  <code style={{ overflowWrap: 'anywhere' }}>
                                    {change.before ?? 'Not set'}
                                  </code>
                                </td>
                                <td>
                                  <code style={{ overflowWrap: 'anywhere' }}>
                                    {change.after ?? 'Removed'}
                                  </code>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    ) : (
                      <p>No configuration changes.</p>
                    )}
                    <details style={{ marginTop: 18 }}>
                      <summary>Resolved contract</summary>
                      <pre className="operator-code">{preview.yaml}</pre>
                    </details>
                    <div style={{ marginTop: 18 }}>
                      <p>Approved data destinations for default and specialist models:</p>
                      <ul>
                        {destinations.map((destination) => (
                          <li key={destination}>
                            <code>{destination}</code>
                          </li>
                        ))}
                      </ul>
                      <label className="check-line">
                        <Input
                          type="checkbox"
                          checked={approved}
                          onChange={(event) => setApproved(event.target.checked)}
                        />
                        I approve the listed model data destinations for this configuration.
                      </label>
                      <Button
                        className="button primary"
                        disabled={
                          !connected ||
                          busy ||
                          !approved ||
                          !preview.safe_diff.length ||
                          validatedDocument !== document
                        }
                        onClick={() => void save()}
                      >
                        {busy ? 'Saving…' : 'Save configuration'}
                      </Button>
                    </div>
                  </>
                )}
              </div>
            )}
          </section>
          <Dialog
            open={!!role}
            title={`${roleNames[role ?? ''] ?? role ?? 'Specialist'} model`}
            description="Inherit the factory default or select a scoped override."
            busy={busy}
            onClose={() => setRole(null)}
          >
            {role && (
              <>
                <label className="check-line">
                  <Input
                    type="checkbox"
                    checked={!draft.models.roles[role as keyof typeof draft.models.roles]}
                    onChange={(event) =>
                      update({
                        ...draft,
                        models: {
                          ...draft.models,
                          roles: {
                            ...draft.models.roles,
                            [role]: event.target.checked ? null : { ...selection },
                          },
                        },
                      })
                    }
                  />
                  Inherit default model
                </label>
                {draft.models.roles[role as keyof typeof draft.models.roles] && (
                  <SelectionFields
                    value={draft.models.roles[role as keyof typeof draft.models.roles]!}
                    onChange={(value) =>
                      update({
                        ...draft,
                        models: { ...draft.models, roles: { ...draft.models.roles, [role]: value } },
                      })
                    }
                  />
                )}
                <p className="operator-readonly">
                  Changes remain in the configuration draft until reviewed and saved.
                </p>
              </>
            )}
          </Dialog>
          <Dialog open={!!credentialIds} title="Provider credential" onClose={() => setCredentialIds(null)}>
            {credentialIds && (
              <Credentials
                api={api}
                targetIds={credentialIds}
                connected={connected}
                onChanged={async () => {
                  const value = await api.integrations();
                  setModelIntegrations(value.filter((item) => item.kind === 'model'));
                  setCredentialMetadata(await api.secrets());
                  await onRefresh?.();
                }}
              />
            )}
          </Dialog>
          <Dialog
            open={newPreference}
            title="Add advisory preference"
            description="Preferences guide the agent; they are not mechanically verified constraints."
            dirty={!!preference.value}
            onClose={() => setNewPreference(false)}
          >
            <form
              onSubmit={(event) => {
                event.preventDefault();
                if (draft.policies.some((item) => item.id === preference.id)) {
                  setError('That policy identifier already exists. Choose a unique identifier.');
                  return;
                }
                update({
                  ...draft,
                  policies: [
                    ...draft.policies,
                    { version: 1, ...preference, mode: 'preference', validator: null },
                  ],
                });
                setNewPreference(false);
                setPreference({ id: '', domain: 'ui', value: '' });
              }}
            >
              <Field label="Stable identifier">
                <Input
                  required
                  pattern={'[a-z][a-z0-9_.\\-]*'}
                  maxLength={100}
                  value={preference.id}
                  onChange={(event) => setPreference({ ...preference, id: event.target.value })}
                />
              </Field>
              <Field label="Policy domain">
                <Select
                  value={preference.domain}
                  onChange={(event) =>
                    setPreference({ ...preference, domain: event.target.value as typeof preference.domain })
                  }
                >
                  {['ui', 'architecture', 'infrastructure', 'delivery', 'security'].map((name) => (
                    <option key={name}>{name}</option>
                  ))}
                </Select>
              </Field>
              <Field label="Preference">
                <Textarea
                  rows={4}
                  required
                  maxLength={4000}
                  value={preference.value}
                  onChange={(event) => setPreference({ ...preference, value: event.target.value })}
                />
              </Field>
              <Button className="button primary">Add to draft</Button>
            </form>
          </Dialog>
        </>
      )}
    </div>
  );
}
