import Button from './components/Button';
import Input from './components/Input';
import Textarea from './components/Textarea';
import { Fragment, useCallback, useEffect, useState, type ReactNode } from 'react';
import { SlidersHorizontal } from 'lucide-react';
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
import PairedBrowsers from './PairedBrowsers';
import { ConfigurationHistoryPanel, RuntimeSettingsPanel } from './features/config/RuntimeSettingsPanel';
import Dialog, { DialogActions } from './components/Dialog';
import Field from './components/FormField';
import Select from './components/Select';
import BudgetFields, { defaultBudgetPolicy } from './components/BudgetFields';
import PageHeader, { Eyebrow } from './components/PageHeader';
import Notice from './components/Notice';
import Disclosure from './components/Disclosure';
import DescriptionList from './components/DescriptionList';
import CheckField from './components/CheckField';
import CodeBlock from './components/CodeBlock';
import LoadingState from './components/LoadingState';
import { Badge } from './components/ui/badge';
import { Card, CardDescription, CardHeader, CardTitle } from './components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './components/ui/table';

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
/** Views grouped by where a setting lives: versioned in the console, or set by the running instance. */
const modeGroups = [
  {
    label: 'Factory · versioned',
    modes: ['Guided setup', 'Policies & limits', 'Context & storage', 'YAML / JSON', 'History'],
  },
  { label: 'Runtime', modes: ['Environment', 'Access'] },
];
const budgetModes = ['patch', 'maintain', 'create', 'audit'] as const;
const compactNumber = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });
const hours = (seconds: number | null) =>
  seconds == null
    ? 'No ceiling'
    : seconds % 3600 === 0
      ? `${seconds / 3600} h`
      : `${Math.round(seconds / 60)} min`;
const steps = ['Connect provider', 'Choose model', 'Connect project', 'Review readiness'];

/** Explanatory fine print under a control or panel. */
const note = 'text-xs leading-relaxed text-muted-foreground';
/** Rows of a bordered list: one record per row, its state on the right. */
const rows = 'grid divide-y divide-border border-y border-border';
const row = 'flex min-w-0 items-start justify-between gap-3 py-3 text-sm';

function Secondary({ children }: { children: ReactNode }) {
  return (
    <small className="mt-1 block text-xs text-muted-foreground [overflow-wrap:anywhere]">{children}</small>
  );
}

function PanelHeading({ id, title, description }: { id?: string; title: string; description?: ReactNode }) {
  return (
    <div className="grid min-w-0 gap-1.5">
      <CardTitle id={id}>{title}</CardTitle>
      {description && <CardDescription>{description}</CardDescription>}
    </div>
  );
}

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
  const [mode, setMode] = useState(
    () =>
      (({ access: 'Access', environment: 'Environment', history: 'History' }) as Record<string, string>)[
        new URLSearchParams(window.location.search).get('section') ?? ''
      ] ?? 'Guided setup',
  );
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
  const accept = useCallback((value: ConfigurationView) => {
    setSaved(value);
    setDraft(value.configuration);
    setDocument(value.yaml);
    setPreview(null);
    setValidatedDocument('');
    setApproved(false);
  }, []);
  const fetchConfiguration = useCallback(
    (current: () => boolean) =>
      Promise.all([
        api.configuration(),
        api.modelConfiguration(),
        api.integrations(),
        api.secrets().catch(() => null),
      ])
        .then(
          ([configuration, models, integrations, metadata]) => {
            if (!current()) return;
            accept(configuration);
            setRunners(models.runners);
            setModelIntegrations(integrations.filter((item) => item.kind === 'model'));
            setCredentialMetadata(metadata);
          },
          (reason: unknown) => {
            if (current()) setError(failure(reason));
          },
        )
        .finally(() => {
          if (current()) setLoading(false);
        }),
    [api, accept],
  );
  useEffect(() => {
    let active = true;
    void fetchConfiguration(() => active);
    return () => {
      active = false;
    };
  }, [fetchConfiguration]);
  const load = () => {
    setLoading(true);
    setError('');
    void fetchConfiguration(() => true);
  };
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
    <div className="@container grid min-w-0 gap-6">
      <PageHeader
        icon={<SlidersHorizontal />}
        title="Config"
        description="Factory-wide defaults. Each run pins a snapshot when it starts, so a change here never alters work in progress. Guided editing and YAML share one validated contract."
        actions={
          <>
            <Badge variant="outline">{saved ? `Revision ${saved.revision}` : 'Loading configuration'}</Badge>
            <Button variant="secondary" disabled={loading || busy || dirty} onClick={load}>
              Refresh
            </Button>
          </>
        }
      />
      {!connected && (
        <Notice tone="warning" role="status">
          Disconnected. Draft edits stay in this view; validation and saving require reconnection.
        </Notice>
      )}
      {error && (
        <Notice tone="danger" role="alert">
          {error}
        </Notice>
      )}
      {notice && (
        <Notice tone="neutral" role="status">
          {notice}
        </Notice>
      )}
      {loading && !draft && <LoadingState label="Loading the effective configuration…" />}
      {draft && saved && selection && (
        <>
          <div className="grid min-w-0 items-start gap-6 @5xl:grid-cols-[12.5rem_minmax(0,1fr)]">
            <nav aria-label="Configuration sections" className="grid min-w-0 gap-4 @5xl:sticky @5xl:top-20">
              <div
                role="group"
                aria-label="Configuration views"
                className="flex w-full max-w-full gap-0.5 overflow-x-auto overscroll-x-contain border-b border-border [scrollbar-width:thin] @5xl:grid @5xl:overflow-visible @5xl:border-b-0"
              >
                {modeGroups.map((group) => (
                  <Fragment key={group.label}>
                    <span
                      aria-hidden="true"
                      className="hidden px-2.5 pt-3 pb-1 text-[0.6875rem] font-semibold tracking-wider text-muted-foreground uppercase first:pt-0 @5xl:block"
                    >
                      {group.label}
                    </span>
                    {group.modes.map((name) => (
                      <Button
                        key={name}
                        disabled={busy}
                        aria-pressed={mode === name}
                        className="-mb-px inline-flex min-h-10 shrink-0 cursor-pointer items-center border-b-2 border-transparent px-3 py-1.5 text-sm font-medium whitespace-nowrap text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-50 aria-pressed:border-primary aria-pressed:text-foreground @5xl:mb-0 @5xl:min-h-9 @5xl:rounded-md @5xl:border-b-0 @5xl:px-2.5 @5xl:aria-pressed:bg-accent/15 @5xl:aria-pressed:shadow-[inset_2px_0_0_var(--primary)]"
                        onClick={() => void switchMode(name)}
                      >
                        {name}
                      </Button>
                    ))}
                  </Fragment>
                ))}
              </div>
              <div className="hidden gap-1 border-t border-border pt-3 text-xs @5xl:grid">
                <span className="px-2.5 pb-1 text-[0.6875rem] font-semibold tracking-wider text-muted-foreground uppercase">
                  Elsewhere
                </span>
                <Link
                  className="rounded-md px-2.5 py-1.5 text-muted-foreground hover:text-foreground"
                  to="/tools"
                >
                  Connections &amp; credentials →
                </Link>
                <Link
                  className="rounded-md px-2.5 py-1.5 text-muted-foreground hover:text-foreground"
                  to="/agents"
                >
                  Crew &amp; remote agents →
                </Link>
              </div>
            </nav>
            <div className="grid min-w-0 gap-6">
              {mode === 'Guided setup' && (
                <>
                  <div
                    role="group"
                    aria-label="Setup steps"
                    className="grid grid-cols-2 gap-2 @3xl:grid-cols-4"
                  >
                    {steps.map((name, index) => (
                      <Button
                        key={name}
                        aria-pressed={step === index}
                        className="flex min-h-10 cursor-pointer items-center justify-center rounded-md border border-border bg-card px-3 py-2 text-center text-sm text-muted-foreground transition-colors hover:bg-hover hover:text-foreground aria-pressed:border-primary aria-pressed:bg-accent aria-pressed:text-foreground"
                        onClick={() => setStep(index)}
                      >
                        {String(index + 1).padStart(2, '0')} · {name}
                      </Button>
                    ))}
                  </div>
                  <div className="grid min-w-0 items-start gap-5 @5xl:grid-cols-[minmax(0,1.45fr)_minmax(18rem,1fr)]">
                    <Card>
                      <Eyebrow>Step {step + 1} of 4</Eyebrow>
                      {step === 0 && (
                        <>
                          <PanelHeading
                            title="Connect a model provider"
                            description="Choose how specialists access the model. Each method retains its own authentication and destination."
                          />
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
                          <div className="grid justify-items-start gap-2.5 border-t border-border pt-4">
                            <h3 className="text-base font-semibold">
                              {cli ? 'Official account session' : 'Destination-scoped API credential'}
                            </h3>
                            <p className="text-sm">
                              {cli
                                ? 'Connect the dedicated factory runner from your own terminal using the official CLI login. Your everyday CLI session is not imported.'
                                : 'Store a write-only credential for the registered destination. Its value is never included in this document or its exports.'}
                            </p>
                            <Badge
                              variant={
                                (cli ? runner?.authenticated : providerConfigured) ? 'success' : 'warning'
                              }
                              className="whitespace-normal"
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
                            </Badge>
                            {cli && (
                              <p className={note}>
                                In the SABRE terminal:{' '}
                                <code className="font-mono text-foreground">
                                  node infra/ops.mjs{' '}
                                  {selection.provider === 'claude_cli' ? 'claude-login' : 'codex-login'}
                                </code>
                              </p>
                            )}
                            {!cli && providerTargetIds.length ? (
                              <Button
                                variant="secondary"
                                onClick={() => setCredentialIds(providerTargetIds)}
                                disabled={!connected}
                              >
                                Manage provider credential
                              </Button>
                            ) : null}
                          </div>
                          <Notice tone="neutral">
                            <span>
                              Context destination:{' '}
                              <code className="font-mono">
                                {selection.destination || 'Explicit endpoint required'}
                              </code>
                              .{' '}
                              {cli
                                ? 'Subscription limits are managed by the provider.'
                                : 'API spend requires separate run authorization.'}
                            </span>
                          </Notice>
                          <div>
                            <Button variant="primary" onClick={() => setStep(1)}>
                              Continue to model
                            </Button>
                          </div>
                        </>
                      )}
                      {step === 1 && (
                        <>
                          <PanelHeading
                            title="Choose the default model"
                            description="Use one explicit model for the team, then override only the specialists that need a different selection."
                          />
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
                          <p className="text-sm text-muted-foreground">
                            Provider:{' '}
                            <strong className="text-foreground">{providers[selection.provider].title}</strong>
                          </p>
                          <Disclosure summary="Advanced model settings" contentClassName="gap-4 @container">
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
                                  changeDefault({
                                    ...selection,
                                    max_output_tokens: Number(event.target.value),
                                  })
                                }
                              />
                            </Field>
                            {!cli && (
                              <div className="grid gap-4 @md:grid-cols-2">
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
                          </Disclosure>
                          <Disclosure summary="Specialist overrides" contentClassName="pt-0">
                            <ul className={rows}>
                              {Object.entries(draft.models.roles).map(([name, value]) => (
                                <li key={name} className={row}>
                                  <div className="min-w-0">
                                    {roleNames[name] ?? name}
                                    <Secondary>
                                      {value
                                        ? `${providers[value.provider].title} · ${value.name || 'Model required'}`
                                        : `Inherits default · ${selection.name || 'Model required'}`}
                                    </Secondary>
                                  </div>
                                  <Button variant="secondary" size="sm" onClick={() => setRole(name)}>
                                    Edit
                                  </Button>
                                </li>
                              ))}
                            </ul>
                          </Disclosure>
                          <div>
                            <Button
                              variant="primary"
                              disabled={!selection.name.trim()}
                              onClick={() => setStep(2)}
                            >
                              Continue to project
                            </Button>
                          </div>
                        </>
                      )}
                      {step === 2 && (
                        <>
                          <PanelHeading
                            title="Connect a project"
                            description="GitHub supplies source access and draft PR delivery. Read, publish and repository creation use separate scoped credentials."
                          />
                          {projects.length ? (
                            <ul className={rows}>
                              {projects.map((project) => (
                                <li key={project.id} className={row}>
                                  <div className="min-w-0">
                                    <strong className="font-semibold">{project.name}</strong>
                                    <Secondary>{project.repository}</Secondary>
                                    <Secondary>
                                      {project.profile} · {project.gate_commands.length} configured checks ·{' '}
                                      {project.default_branch}
                                    </Secondary>
                                  </div>
                                  <Badge variant="outline">Registered</Badge>
                                </li>
                              ))}
                            </ul>
                          ) : (
                            <Notice tone="warning">
                              No project is registered. Add a repository from the project selector or browse
                              GitHub in Tools.
                            </Notice>
                          )}
                          <p className={note}>
                            Repository permissions and executable checks are checked at launch. A saved
                            credential alone does not establish readiness.
                          </p>
                          <div className="flex flex-wrap items-center gap-2">
                            <Button variant="secondary" asChild>
                              <Link to="/tools">Manage repository access</Link>
                            </Button>
                            <Button variant="primary" onClick={() => setStep(3)}>
                              Review readiness
                            </Button>
                          </div>
                        </>
                      )}
                      {step === 3 && (
                        <>
                          <PanelHeading
                            title="Review readiness"
                            description="These checks describe the saved revision. Draft changes must be validated and saved before they affect future runs."
                          />
                          <ul className={rows}>
                            {saved.readiness.map((item) => (
                              <li key={item.id} className={row}>
                                <div className="min-w-0">
                                  {item.message}
                                  <Secondary>{item.action}</Secondary>
                                </div>
                                <Badge variant={item.status === 'ready' ? 'success' : 'warning'}>
                                  {item.status === 'ready'
                                    ? 'Configured'
                                    : item.status === 'unavailable'
                                      ? 'Unavailable'
                                      : 'Action needed'}
                                </Badge>
                              </li>
                            ))}
                          </ul>
                          <Notice tone="neutral">
                            Connection, explicit model, repository access and delivery authorization are
                            separate. Final model and permission checks run before dispatch.
                          </Notice>
                        </>
                      )}
                    </Card>
                    <aside
                      aria-labelledby="config-effective-title"
                      className="flex min-w-0 flex-col gap-4 rounded-lg border border-border bg-card p-5 @5xl:sticky @5xl:top-20"
                    >
                      <div className="grid gap-1.5">
                        <Eyebrow>Effective draft</Eyebrow>
                        <h2 id="config-effective-title" className="text-lg leading-snug font-semibold">
                          What the factory will use
                        </h2>
                      </div>
                      <DescriptionList
                        termWidth="8rem"
                        items={[
                          ['Provider', providers[selection.provider].title],
                          ['Model', selection.name || 'Not selected'],
                          [
                            'Team',
                            `${Object.values(draft.models.roles).filter(Boolean).length} overrides · ${
                              Object.values(draft.models.roles).filter((value) => !value).length
                            } inherited`,
                          ],
                          ['Routing order', 'Run phase → flow phase → specialist → default'],
                          ['Source', dirty ? 'Unsaved draft' : `Saved revision ${saved.revision}`],
                          ['Permissions', 'Resolved and pinned at launch'],
                        ]}
                      />
                      <Disclosure summary="View secret-free contract" variant="plain" contentClassName="pl-0">
                        <CodeBlock label="Secret-free configuration contract">{encode(draft)}</CodeBlock>
                      </Disclosure>
                      <p className={note}>
                        Saving configuration never starts a run or publishes repository changes.
                      </p>
                    </aside>
                  </div>
                </>
              )}
              {mode === 'YAML / JSON' && (
                <Card aria-labelledby="config-contract-title">
                  <PanelHeading
                    id="config-contract-title"
                    title="Versioned configuration contract"
                    description="The server validates YAML and JSON against the same schema as guided setup. Aliases, duplicate keys, unknown capabilities and input over 64 KiB are rejected."
                  />
                  <Field label="Configuration document">
                    <Textarea
                      value={document}
                      maxLength={65536}
                      rows={24}
                      spellCheck={false}
                      className="font-mono text-xs leading-relaxed"
                      onChange={(event) => {
                        setDocument(event.target.value);
                        setPreview(null);
                        setApproved(false);
                      }}
                    />
                  </Field>
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                    <Button
                      variant="secondary"
                      disabled={
                        document !== saved.yaml &&
                        !(preview?.valid && preview.yaml && validatedDocument === document)
                      }
                      onClick={() => {
                        const exportDocument =
                          preview?.valid && validatedDocument === document ? preview.yaml : saved.yaml;
                        if (!exportDocument) return;
                        const url = URL.createObjectURL(
                          new Blob([exportDocument], { type: 'application/yaml' }),
                        );
                        const link = window.document.createElement('a');
                        link.href = url;
                        link.download = 'sabre-configuration.yaml';
                        link.click();
                        URL.revokeObjectURL(url);
                      }}
                    >
                      Download document
                    </Button>
                    <p className={note}>
                      Exports use the saved or server-validated secret-free contract. Validate draft edits
                      before downloading.
                    </p>
                  </div>
                </Card>
              )}
              {mode === 'Policies & limits' && (
                <>
                  <Card aria-labelledby="config-budgets-title">
                    <PanelHeading
                      id="config-budgets-title"
                      title="Budget defaults by mode"
                      description="Applied when a run starts without its own limits. Each metric also keeps a reserve and an absolute ceiling; edit them per flow below."
                    />
                    <div className="overflow-x-auto rounded-lg border border-border">
                      <table className="w-full min-w-[34rem] border-collapse text-sm">
                        <thead className="bg-secondary/50 text-left text-xs text-muted-foreground">
                          <tr>
                            {[
                              'Mode',
                              'Tokens',
                              'Invocations',
                              'Active time',
                              'Repairs',
                              'No-progress stop',
                            ].map((head) => (
                              <th key={head} scope="col" className="px-3 py-2 font-medium">
                                {head}
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {budgetModes.map((name) => {
                            const own = draft.flows[name].budget_policy;
                            const policy = own ?? defaultBudgetPolicy;
                            return (
                              <tr key={name} className="border-t border-border">
                                <th scope="row" className="px-3 py-2 text-left font-medium capitalize">
                                  {name}
                                  {!own && (
                                    <span className="ml-2 text-xs font-normal text-muted-foreground">
                                      factory default
                                    </span>
                                  )}
                                </th>
                                <td className="px-3 py-2 font-mono text-xs">
                                  {policy.tokens.primary == null
                                    ? 'No ceiling'
                                    : compactNumber.format(policy.tokens.primary)}
                                </td>
                                <td className="px-3 py-2 font-mono text-xs">
                                  {policy.invocations.primary ?? 'No ceiling'}
                                </td>
                                <td className="px-3 py-2 font-mono text-xs">
                                  {hours(policy.active_seconds.primary)}
                                </td>
                                <td className="px-3 py-2 font-mono text-xs">
                                  {policy.repairs.primary ?? 'No ceiling'}
                                </td>
                                <td className="px-3 py-2 font-mono text-xs">
                                  {policy.no_progress_threshold}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                    {budgetModes.every((name) => !draft.flows[name].budget_policy) && (
                      <p className={note}>
                        Every mode uses the same factory default. Decide per-mode limits before real runs: an
                        audit reads more than a patch changes.
                      </p>
                    )}
                  </Card>
                  <Card aria-labelledby="config-policies-title">
                    <CardHeader>
                      <PanelHeading
                        id="config-policies-title"
                        title="Policy domains"
                        description="Required rules use registered validators. Preferences guide work and require human review."
                      />
                      <Button variant="secondary" onClick={() => setNewPreference(true)}>
                        Add preference
                      </Button>
                    </CardHeader>
                    <ul className={rows}>
                      {draft.policies.map((policy, index) => (
                        <li key={policy.id} className={row}>
                          <div className="grid min-w-0 flex-1 gap-2">
                            <div>
                              <strong className="font-semibold">{policy.id}</strong>
                              <Secondary>
                                {policy.domain} ·{' '}
                                {policy.mode === 'required'
                                  ? `Validator: ${policy.validator}`
                                  : 'Advisory · human review'}{' '}
                                · version {policy.version} · factory contract
                              </Secondary>
                            </div>
                            {policy.mode === 'required' ? (
                              <p className="text-sm">{policy.value}</p>
                            ) : (
                              <Textarea
                                aria-label={`Preference ${policy.id}`}
                                value={policy.value}
                                maxLength={4000}
                                rows={2}
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
                          <Badge variant={policy.mode === 'required' ? 'warning' : 'outline'}>
                            {policy.mode === 'required' ? 'Required' : 'Preference'}
                          </Badge>
                        </li>
                      ))}
                    </ul>
                  </Card>
                  <Card aria-labelledby="config-flows-title">
                    <PanelHeading
                      id="config-flows-title"
                      title="Flow defaults"
                      description="Choose a registered flow, then refine permissions and phase overrides. Runs pin the resolved configuration."
                    />
                    <Field label="Flow" className="max-w-80">
                      <Select value={flow} onChange={(event) => setFlow(event.target.value as typeof flow)}>
                        {['patch', 'maintain', 'create', 'audit'].map((name) => (
                          <option key={name} value={name}>
                            {name}
                          </option>
                        ))}
                      </Select>
                    </Field>
                    <div className="grid items-start gap-5 @3xl:grid-cols-2">
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
                      <div className="grid gap-2.5">
                        <p className="text-sm font-medium">Flow permissions</p>
                        {(['architecture', 'dependency_changes', 'draft_pull_request'] as const).map(
                          (name) => (
                            <CheckField
                              key={name}
                              label={name.replaceAll('_', ' ')}
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
                          ),
                        )}
                      </div>
                    </div>
                    <Disclosure summary="Run budgets and recovery" contentClassName="gap-4">
                      <CheckField
                        label="Use a versioned budget policy for this flow"
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
                      {draft.flows[flow].budget_policy ? (
                        <BudgetFields
                          value={draft.flows[flow].budget_policy!}
                          onChange={(value) =>
                            update({
                              ...draft,
                              flows: {
                                ...draft.flows,
                                [flow]: { ...draft.flows[flow], budget_policy: value },
                              },
                            })
                          }
                        />
                      ) : (
                        <p className={note}>
                          This flow keeps its existing launch-budget behavior until an explicit policy is
                          selected.
                        </p>
                      )}
                    </Disclosure>
                    <Disclosure summary="Advanced phase models and skills" contentClassName="gap-0 pt-0">
                      <div className={rows}>
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
                              <Disclosure
                                key={phase}
                                variant="plain"
                                className="py-1.5 [&:not([open])>summary>svg]:rotate-0"
                                contentClassName="gap-4 pb-3"
                                summary={
                                  <span className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
                                    <span className="capitalize">{phase}</span>
                                    <span className="text-xs font-normal text-muted-foreground">
                                      {override?.name ||
                                        phaseValue?.model?.name ||
                                        'inherits specialist/default'}
                                    </span>
                                  </span>
                                }
                              >
                                <CheckField
                                  label="Override model for this flow phase"
                                  checked={!!override}
                                  onChange={(event) => {
                                    const phase_models = { ...draft.flows[flow].phase_models };
                                    if (event.target.checked) phase_models[phase] = { ...selection };
                                    else delete phase_models[phase];
                                    update({
                                      ...draft,
                                      flows: {
                                        ...draft.flows,
                                        [flow]: { ...draft.flows[flow], phase_models },
                                      },
                                    });
                                  }}
                                />
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
                                            phase_models: {
                                              ...draft.flows[flow].phase_models,
                                              [phase]: value,
                                            },
                                          },
                                        },
                                      })
                                    }
                                  />
                                )}
                                <fieldset className="grid gap-2.5">
                                  <legend className="mb-2.5 text-sm font-medium">Registered skills</legend>
                                  {skills.map((skill) => (
                                    <CheckField
                                      key={skill}
                                      label={skill}
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
                                  ))}
                                </fieldset>
                              </Disclosure>
                            );
                          })}
                      </div>
                    </Disclosure>
                  </Card>
                </>
              )}
              {mode === 'Access' && <PairedBrowsers api={api} />}
              {mode === 'Environment' && <RuntimeSettingsPanel api={api} />}
              {mode === 'History' && <ConfigurationHistoryPanel api={api} revision={saved.revision} />}
              {mode === 'Context & storage' && (
                <div className="grid min-w-0 items-start gap-5 @4xl:grid-cols-2">
                  <Card aria-labelledby="config-context-title">
                    <PanelHeading
                      id="config-context-title"
                      title="Context preparation"
                      description="Bound input and preserve source references. Context settings cannot grant execution permissions."
                    />
                    <div className="grid gap-2.5">
                      <CheckField
                        label="Deduplicate repeated context"
                        checked={draft.context.deduplicate}
                        onChange={(event) =>
                          update({
                            ...draft,
                            context: { ...draft.context, deduplicate: event.target.checked },
                          })
                        }
                      />
                      <CheckField
                        label="Archive recorded source reads"
                        checked={draft.context.archive_reads}
                        onChange={(event) =>
                          update({
                            ...draft,
                            context: { ...draft.context, archive_reads: event.target.checked },
                          })
                        }
                      />
                    </div>
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
                  </Card>
                  <Card aria-labelledby="config-storage-title">
                    <PanelHeading id="config-storage-title" title="Storage and provenance" />
                    <DescriptionList
                      items={[
                        ['Persistent store', 'PostgreSQL'],
                        ['Source navigation', 'Project-scoped text search'],
                        ['Semantic retrieval', 'Optional provider; inspect each project in Memory'],
                        ['Credentials', 'Encrypted, write-only and destination scoped'],
                      ]}
                    />
                    <p className="text-sm text-muted-foreground">
                      The active storage system is managed by the instance. No migration or database change is
                      performed by this form.
                    </p>
                  </Card>
                </div>
              )}
              {!['Access', 'Environment', 'History'].includes(mode) && (
                <Card aria-labelledby="config-validate-title">
                  <CardHeader>
                    <PanelHeading
                      id="config-validate-title"
                      title="Validate and review"
                      description="Preview the server-resolved contract and changed fields before saving. Validation does not run agents, grant permissions or publish."
                    />
                    <div className="flex flex-wrap items-center gap-2">
                      {dirty && (
                        <Button variant="secondary" disabled={busy} onClick={() => accept(saved)}>
                          Discard draft
                        </Button>
                      )}
                      <Button variant="primary" disabled={busy || !connected} onClick={() => void validate()}>
                        {busy ? 'Checking…' : 'Validate & preview'}
                      </Button>
                    </div>
                  </CardHeader>
                  {preview && (
                    <div className="grid min-w-0 justify-items-start gap-4 border-t border-border pt-4">
                      <Badge variant={preview.valid ? 'success' : 'warning'}>
                        {preview.valid ? 'Schema validated' : 'Changes required'}
                      </Badge>
                      {preview.diagnostics.length > 0 && (
                        <ul
                          role="alert"
                          className="grid w-full gap-1.5 rounded-lg border border-danger-border bg-danger-bg px-4 py-3 text-sm text-danger"
                        >
                          {preview.diagnostics.map((item, index) => (
                            <li key={`${item.path}-${index}`} className="[overflow-wrap:anywhere]">
                              <code className="font-mono text-xs">{item.path}</code>: {item.message}
                            </li>
                          ))}
                        </ul>
                      )}
                      {preview.valid && (
                        <div className="grid w-full min-w-0 gap-4">
                          {preview.safe_diff.length ? (
                            <Table>
                              <TableHeader>
                                <TableRow>
                                  <TableHead>Field</TableHead>
                                  <TableHead>Saved value</TableHead>
                                  <TableHead>Proposed value</TableHead>
                                </TableRow>
                              </TableHeader>
                              <TableBody>
                                {preview.safe_diff.map((change) => (
                                  <TableRow key={change.path}>
                                    <TableCell>
                                      <code className="font-mono text-xs">{change.path}</code>
                                    </TableCell>
                                    <TableCell>
                                      <code className="font-mono text-xs">{change.before ?? 'Not set'}</code>
                                    </TableCell>
                                    <TableCell>
                                      <code className="font-mono text-xs">{change.after ?? 'Removed'}</code>
                                    </TableCell>
                                  </TableRow>
                                ))}
                              </TableBody>
                            </Table>
                          ) : (
                            <p className="text-sm">No configuration changes.</p>
                          )}
                          <Disclosure summary="Resolved contract" variant="plain" contentClassName="pl-0">
                            <CodeBlock label="Resolved configuration contract">{preview.yaml}</CodeBlock>
                          </Disclosure>
                          <div className="grid gap-3">
                            <p className="text-sm">
                              Approved data destinations for default and specialist models:
                            </p>
                            <ul className="grid list-disc gap-1 pl-5 text-sm">
                              {destinations.map((destination) => (
                                <li key={destination} className="[overflow-wrap:anywhere]">
                                  <code className="font-mono text-xs">{destination}</code>
                                </li>
                              ))}
                            </ul>
                            <CheckField
                              label="I approve the listed model data destinations for this configuration."
                              checked={approved}
                              onChange={(event) => setApproved(event.target.checked)}
                            />
                            <div>
                              <Button
                                variant="primary"
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
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </Card>
              )}
            </div>
          </div>
          <Dialog
            open={!!role}
            title={`${roleNames[role ?? ''] ?? role ?? 'Specialist'} model`}
            description="Inherit the factory default or select a scoped override."
            busy={busy}
            onClose={() => setRole(null)}
          >
            {role && (
              <div className="grid gap-4">
                <CheckField
                  label="Inherit default model"
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
                <p className={note}>Changes remain in the configuration draft until reviewed and saved.</p>
              </div>
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
              className="grid gap-4"
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
              <DialogActions>
                <Button variant="primary">Add to draft</Button>
              </DialogActions>
            </form>
          </Dialog>
        </>
      )}
    </div>
  );
}
