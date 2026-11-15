import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { ApiError, type Api, type ModelConfiguration as Configuration, type ModelSelection } from './api';
import Field from './components/FormField';
import Select from './components/Select';
import Input from './components/Input';
import Button from './components/Button';
import Notice from './components/Notice';
import Disclosure from './components/Disclosure';
import CheckField from './components/CheckField';
import { SectionHeading } from './components/PageHeader';

export const providers: Record<ModelSelection['provider'], { title: string; destination: string }> = {
  codex_cli: { title: 'Codex · CLI', destination: 'http://codex-runner:8091' },
  claude_cli: { title: 'Claude Code · CLI', destination: 'http://claude-runner:8092' },
  openai: { title: 'OpenAI · API', destination: 'https://api.openai.com/v1' },
  anthropic: { title: 'Anthropic · API', destination: 'https://api.anthropic.com' },
  google: { title: 'Google · API', destination: 'https://generativelanguage.googleapis.com' },
  local: { title: 'Compatible endpoint', destination: '' },
};
export type Effort = NonNullable<ModelSelection['effort']>;
// Every level the contract names has a label: one added to the API fails the type check here until it has its own.
const effortLabels: Record<Effort, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Maximum',
};
/** The levels each provider takes, for the providers where the factory sets one. The API refuses any other. */
export const effortLevels: Partial<Record<ModelSelection['provider'], readonly Effort[]>> = {
  claude_cli: ['low', 'medium', 'high', 'xhigh', 'max'],
};

/**
 * The selection with this effort, or with none. Unset, the key is absent, as in what the API returns,
 * so a form nobody touched is not a change.
 */
export function withEffort(value: ModelSelection, effort: Effort | ''): ModelSelection {
  const next = { ...value };
  if (effort) next.effort = effort;
  else delete next.effort;
  return next;
}

/** How a selection's effort reads, or null where the provider has no such setting. */
export function effortSummary(value: ModelSelection): string | null {
  if (!effortLevels[value.provider]) return null;
  return value.effort ? effortLabels[value.effort] : 'Provider default';
}

/** What follows a model's name when its selection names an effort; nothing when the provider decides. */
export function effortNote(value: ModelSelection): string {
  return value.effort ? ` · ${effortLabels[value.effort]} effort` : '';
}

const roles: Record<string, string> = {
  supervisor: 'Supervisor',
  analyst: 'Analyst',
  architect: 'Architect',
  developer: 'Development',
  qa: 'Verification',
  reviewer: 'Technical review',
  security: 'Security',
};

function message(error: unknown) {
  return error instanceof ApiError
    ? error.message
    : 'Configuration could not be confirmed. Refresh its status.';
}

export function SelectionFields({
  value,
  onChange,
}: {
  value: ModelSelection;
  onChange: (value: ModelSelection) => void;
}) {
  const cli = value.provider === 'codex_cli' || value.provider === 'claude_cli';
  return (
    <div className="@container min-w-0">
      <div className="grid min-w-0 items-start gap-4 @lg:grid-cols-2">
        <Field label="Provider">
          <Select
            value={value.provider}
            onChange={(event) => {
              const provider = event.target.value as ModelSelection['provider'];
              // The levels are the provider's: an effort chosen for one is not carried to another.
              onChange(
                withEffort(
                  {
                    ...value,
                    provider,
                    destination: providers[provider].destination,
                    name: '',
                    input_usd_per_million: 0,
                    output_usd_per_million: 0,
                    cache_read_usd_per_million: null,
                    cache_write_usd_per_million: null,
                  },
                  '',
                ),
              );
            }}
          >
            {Object.entries(providers).map(([id, provider]) => (
              <option key={id} value={id}>
                {provider.title}
              </option>
            ))}
          </Select>
        </Field>
        <Field
          label="Model"
          hint={
            cli
              ? 'Choose an explicit model for reproducible flow configuration. Providers never switch automatically.'
              : 'Identifier of the authorized model.'
          }
        >
          <Input
            value={value.name}
            maxLength={128}
            pattern={'[A-Za-z0-9._:\\/\\-]*'}
            required={!cli}
            autoComplete="off"
            onChange={(event) => onChange({ ...value, name: event.target.value })}
          />
        </Field>
        <Field
          label="Destination"
          hint={
            cli
              ? `Private SABRE bridge. Context is sent to ${value.provider === 'claude_cli' ? 'Anthropic through Claude' : 'OpenAI through Codex'}.`
              : 'Context for this role will be sent to this service.'
          }
        >
          <Input
            type="url"
            value={value.destination}
            required
            readOnly={value.provider !== 'local'}
            autoComplete="off"
            onChange={(event) => onChange({ ...value, destination: event.target.value })}
          />
        </Field>
        <Field
          label={cli ? 'Output reference' : 'Maximum output'}
          hint="The CLI retains its internal limits; SABRE controls duration and concurrency."
        >
          <Input
            type="number"
            min={128}
            max={32768}
            step={1}
            required
            value={value.max_output_tokens}
            onChange={(event) => onChange({ ...value, max_output_tokens: Number(event.target.value) })}
          />
        </Field>
        <EffortField value={value} onChange={onChange} />
        {!cli && (
          <>
            <Field label="USD per million input tokens">
              <Input
                type="number"
                min={0}
                step="any"
                required
                value={value.input_usd_per_million}
                onChange={(event) =>
                  onChange({ ...value, input_usd_per_million: Number(event.target.value) })
                }
              />
            </Field>
            <Field label="USD per million output tokens">
              <Input
                type="number"
                min={0}
                step="any"
                required
                value={value.output_usd_per_million}
                onChange={(event) =>
                  onChange({ ...value, output_usd_per_million: Number(event.target.value) })
                }
              />
            </Field>
            <CachePriceFields value={value} onChange={onChange} />
          </>
        )}
      </div>
    </div>
  );
}

/** The reasoning effort of a selection, for a provider where the factory sets one; nothing for the others. */
export function EffortField({
  value,
  onChange,
}: {
  value: ModelSelection;
  onChange: (value: ModelSelection) => void;
}) {
  const levels = effortLevels[value.provider];
  if (!levels) return null;
  return (
    <Field
      label="Reasoning effort"
      hint="How thoroughly the model works on each call; higher levels spend more tokens. On the provider default, the Claude CLI chooses by model. It lowers or ignores a level the model does not take."
    >
      <Select
        value={value.effort ?? ''}
        onChange={(event) => onChange(withEffort(value, event.target.value as Effort | ''))}
      >
        <option value="">Provider default</option>
        {levels.map((level) => (
          <option key={level} value={level}>
            {effortLabels[level]}
          </option>
        ))}
      </Select>
    </Field>
  );
}

/** Optional prices of cached input. Left empty, cached tokens are charged at the input price. */
export function CachePriceFields({
  value,
  onChange,
}: {
  value: ModelSelection;
  onChange: (value: ModelSelection) => void;
}) {
  const price = (text: string) => (text.trim() === '' ? null : Number(text));
  return (
    <>
      <Field
        label="USD per million cached input tokens"
        hint="Input read from the provider's cache. Empty: charged at the input price."
      >
        <Input
          type="number"
          min={0}
          step="any"
          value={value.cache_read_usd_per_million ?? ''}
          onChange={(event) => onChange({ ...value, cache_read_usd_per_million: price(event.target.value) })}
        />
      </Field>
      <Field
        label="USD per million tokens written to the cache"
        hint="Input the provider stores for later calls. Empty: charged at the input price."
      >
        <Input
          type="number"
          min={0}
          step="any"
          value={value.cache_write_usd_per_million ?? ''}
          onChange={(event) => onChange({ ...value, cache_write_usd_per_million: price(event.target.value) })}
        />
      </Field>
    </>
  );
}

export default function ModelConfiguration({
  api,
  onChanged,
  scope = 'all',
}: {
  api: Api;
  onChanged: () => Promise<void>;
  scope?: 'all' | 'default' | 'agents';
}) {
  const [saved, setSaved] = useState<Configuration | null>(null);
  const [general, setGeneral] = useState<ModelSelection | null>(null);
  const [overrides, setOverrides] = useState<Record<string, ModelSelection | null>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [approved, setApproved] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [selectedRole, setSelectedRole] = useState('developer');
  const accept = useCallback((value: Configuration) => {
    setSaved(value);
    setGeneral(value.default);
    setOverrides(Object.fromEntries(value.roles.map((role) => [role.role, role.override ?? null])));
    setApproved(false);
  }, []);
  const fetchModels = useCallback(
    (current: () => boolean) =>
      api
        .modelConfiguration()
        .then(
          (value) => {
            if (current()) accept(value);
          },
          (reason: unknown) => {
            if (current()) setError(message(reason));
          },
        )
        .finally(() => {
          if (current()) setLoading(false);
        }),
    [api, accept],
  );
  useEffect(() => {
    let active = true;
    void fetchModels(() => active);
    return () => {
      active = false;
    };
  }, [fetchModels]);
  const load = () => {
    setLoading(true);
    setError('');
    void fetchModels(() => true);
  };
  const dirty =
    !!saved &&
    !!general &&
    JSON.stringify({ default: general, roles: overrides }) !==
      JSON.stringify({
        default: saved.default,
        roles: Object.fromEntries(saved.roles.map((role) => [role.role, role.override ?? null])),
      });
  const destinations = general
    ? [
        ...new Set([
          general.destination,
          ...Object.values(overrides)
            .filter((value): value is ModelSelection => !!value)
            .map((value) => value.destination),
        ]),
      ].sort()
    : [];
  const change = (role: string, value: ModelSelection | null) => {
    setOverrides((current) => ({ ...current, [role]: value }));
    setApproved(false);
    setNotice('');
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!saved || !general || !approved || saving || !dirty) return;
    setSaving(true);
    setError('');
    setNotice('');
    try {
      accept(
        await api.saveModelConfiguration({
          expected_revision: saved.revision,
          default: general,
          roles: overrides,
          approved_destinations: destinations,
        }),
      );
      setNotice(
        'Configuration saved. New runs use this revision; existing runs retain their pinned configuration.',
      );
      await onChanged();
    } catch (reason) {
      setError(message(reason));
    } finally {
      setSaving(false);
    }
  };
  return (
    <section className="grid min-w-0 gap-5" aria-labelledby="model-configuration-title">
      <SectionHeading
        id="model-configuration-title"
        title={
          scope === 'agents'
            ? 'Agent model assignments'
            : scope === 'default'
              ? 'Factory default model'
              : 'Models and team'
        }
        description="Assign a model to each specialty. SABRE retains control of the flow, memory and permissions."
        actions={
          <Button type="button" variant="secondary" size="sm" disabled={loading || saving} onClick={load}>
            Refresh models
          </Button>
        }
      />
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
      {loading && !saved && (
        <p role="status" className="text-sm text-muted-foreground">
          Loading models…
        </p>
      )}
      {saved && general && (
        <>
          <ul
            className="grid min-w-0 [grid-template-columns:repeat(auto-fit,minmax(min(100%,16rem),1fr))] gap-3"
            aria-label="Runner sessions"
          >
            {saved.runners.map((runner) => (
              <li
                key={runner.provider}
                className="grid min-w-0 content-start gap-1 rounded-lg border border-border bg-card p-4 text-sm"
              >
                <strong className="font-semibold">
                  {providers[runner.provider as ModelSelection['provider']]?.title ?? runner.provider}
                </strong>
                <span
                  className={runner.authenticated && !runner.busy ? 'text-success' : 'text-muted-foreground'}
                >
                  {runner.busy
                    ? 'Busy · session not checked'
                    : !runner.available
                      ? 'Runner unavailable'
                      : runner.authenticated
                        ? 'Session connected'
                        : 'Session connection required'}
                </span>
                {runner.error_code === 'CLAUDE_POLICY_UNSUPPORTED' && (
                  <small className="text-xs text-muted-foreground [overflow-wrap:anywhere]">
                    Use an account supported by the official CLI and your organization policies.
                  </small>
                )}
                {!runner.busy &&
                  runner.authenticated !== true &&
                  runner.error_code !== 'CLAUDE_POLICY_UNSUPPORTED' && (
                    <small className="text-xs text-muted-foreground [overflow-wrap:anywhere]">
                      {runner.provider === 'claude_cli'
                        ? 'Connect from the SABRE terminal: node infra/ops.mjs claude-login'
                        : 'Connect from the SABRE terminal: node infra/ops.mjs codex-login'}
                    </small>
                  )}
              </li>
            ))}
          </ul>
          {scope === 'agents' && (
            <div
              role="group"
              className="grid min-w-0 [grid-template-columns:repeat(auto-fill,minmax(min(100%,13rem),1fr))] gap-2"
              aria-label="Runtime specialists"
            >
              {saved.roles.map((role) => (
                <button
                  type="button"
                  className="grid min-h-10 min-w-0 cursor-pointer gap-1 rounded-md border border-border bg-card px-3 py-2.5 text-left text-sm transition-colors hover:bg-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring aria-pressed:border-primary aria-pressed:bg-accent"
                  key={role.role}
                  aria-pressed={selectedRole === role.role}
                  onClick={() => setSelectedRole(role.role)}
                >
                  <strong className="font-semibold">{roles[role.role] ?? role.role}</strong>
                  <small className="text-xs text-muted-foreground [overflow-wrap:anywhere]">
                    {overrides[role.role]
                      ? `${providers[overrides[role.role]!.provider].title} · ${overrides[role.role]!.name || 'Not selected'}${effortNote(overrides[role.role]!)}`
                      : `Inherits factory default · ${general.name || 'Not selected'}${effortNote(general)}`}
                  </small>
                </button>
              ))}
            </div>
          )}
          <form onSubmit={(event) => void submit(event)}>
            <fieldset disabled={loading || saving} className="grid min-w-0 gap-3">
              <legend className="mb-3 text-sm text-muted-foreground">
                Team configuration · revision {saved.revision}
              </legend>
              <Disclosure
                open={scope !== 'agents'}
                summary={
                  <span className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
                    <strong className="font-semibold">Default model</strong>
                    <span className="text-xs font-normal text-muted-foreground">
                      {providers[general.provider].title} · {general.name || 'Not selected'}
                      {effortNote(general)}
                    </span>
                  </span>
                }
              >
                <SelectionFields
                  value={general}
                  onChange={(value) => {
                    setGeneral(value);
                    setApproved(false);
                    setNotice('');
                  }}
                />
              </Disclosure>
              {scope !== 'default' &&
                saved.roles
                  .filter((role) => scope !== 'agents' || role.role === selectedRole)
                  .map((role) => {
                    const value = overrides[role.role] ?? null;
                    const effective = value ?? general;
                    return (
                      <Disclosure
                        key={role.role}
                        open={scope === 'agents' ? true : undefined}
                        summary={
                          <span className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
                            <strong className="font-semibold">{roles[role.role] ?? role.role}</strong>
                            <span className="text-xs font-normal text-muted-foreground">
                              {value ? providers[effective.provider].title : 'Inherits the default model'} ·{' '}
                              {effective.name || 'Not selected'}
                              {effortNote(effective)}
                            </span>
                          </span>
                        }
                      >
                        <CheckField
                          label="Inherit the default model"
                          checked={!value}
                          onChange={(event) =>
                            change(role.role, event.target.checked ? null : { ...general })
                          }
                        />
                        {value && (
                          <SelectionFields value={value} onChange={(next) => change(role.role, next)} />
                        )}
                        {role.credential_target && (
                          <p className="text-sm text-muted-foreground">
                            Saved credential target:{' '}
                            <code className="font-mono text-xs">{role.credential_target}</code>. Manage keys
                            in the model connection.
                          </p>
                        )}
                      </Disclosure>
                    );
                  })}
              <div className="grid gap-2.5 py-1 text-sm">
                <p>Team destinations for this configuration</p>
                <ul className="grid list-disc gap-1 pl-5">
                  {destinations.map((destination) => (
                    <li key={destination} className="[overflow-wrap:anywhere]">
                      <code className="font-mono text-xs">{destination || 'Destination required'}</code>
                    </li>
                  ))}
                </ul>
                <CheckField
                  label="I authorize sending each role context to its listed destinations."
                  checked={approved}
                  onChange={(event) => setApproved(event.target.checked)}
                />
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button type="submit" variant="primary" disabled={!dirty || !approved || saving}>
                  {saving ? 'Saving…' : 'Save models'}
                </Button>
                {dirty && (
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={() => {
                      accept(saved);
                      setNotice('');
                    }}
                  >
                    Discard changes
                  </Button>
                )}
              </div>
              <p className="text-xs leading-relaxed text-muted-foreground">
                Changing provider does not transfer credentials or increase run budgets. CLI subscription fees
                are separate from recorded API charges.
              </p>
            </fieldset>
          </form>
        </>
      )}
    </section>
  );
}
