import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { ApiError, type Api, type ModelConfiguration as Configuration, type ModelSelection } from './api';
import Field from './components/FormField';
import Select from './components/Select';
import './ModelConfiguration.css';

const providers: Record<ModelSelection['provider'], { title: string; destination: string }> = {
  codex_cli: { title: 'Codex · CLI', destination: 'http://codex-runner:8091' },
  claude_cli: { title: 'Claude · CLI', destination: 'http://claude-runner:8092' },
  openai: { title: 'OpenAI · API', destination: 'https://api.openai.com/v1' },
  anthropic: { title: 'Anthropic · API', destination: 'https://api.anthropic.com' },
  google: { title: 'Google · API', destination: 'https://generativelanguage.googleapis.com' },
  local: { title: 'Endpoint compatible local', destination: '' },
};
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
    <div className="model-fields">
      <Field label="Provider">
        <Select
          value={value.provider}
          onChange={(event) => {
            const provider = event.target.value as ModelSelection['provider'];
            onChange({
              ...value,
              provider,
              destination: providers[provider].destination,
              name: '',
              input_usd_per_million: 0,
              output_usd_per_million: 0,
            });
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
        <input
          value={value.name}
          maxLength={128}
          pattern="[A-Za-z0-9._:/-]*"
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
        <input
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
        <input
          type="number"
          min={128}
          max={32768}
          step={1}
          required
          value={value.max_output_tokens}
          onChange={(event) => onChange({ ...value, max_output_tokens: Number(event.target.value) })}
        />
      </Field>
      {!cli && (
        <>
          <Field label="USD per million input tokens">
            <input
              type="number"
              min={0}
              step="any"
              required
              value={value.input_usd_per_million}
              onChange={(event) => onChange({ ...value, input_usd_per_million: Number(event.target.value) })}
            />
          </Field>
          <Field label="USD per million output tokens">
            <input
              type="number"
              min={0}
              step="any"
              required
              value={value.output_usd_per_million}
              onChange={(event) => onChange({ ...value, output_usd_per_million: Number(event.target.value) })}
            />
          </Field>
        </>
      )}
    </div>
  );
}

export default function ModelConfiguration({ api, onChanged }: { api: Api; onChanged: () => Promise<void> }) {
  const [saved, setSaved] = useState<Configuration | null>(null);
  const [general, setGeneral] = useState<ModelSelection | null>(null);
  const [overrides, setOverrides] = useState<Record<string, ModelSelection | null>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [approved, setApproved] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const accept = useCallback((value: Configuration) => {
    setSaved(value);
    setGeneral(value.default);
    setOverrides(Object.fromEntries(value.roles.map((role) => [role.role, role.override ?? null])));
    setApproved(false);
  }, []);
  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      accept(await api.modelConfiguration());
    } catch (reason) {
      setError(message(reason));
    } finally {
      setLoading(false);
    }
  }, [api, accept]);
  useEffect(() => {
    void load();
  }, [load]);
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
    <section className="model-configuration" aria-labelledby="model-configuration-title">
      <div className="section-heading">
        <div>
          <h2 id="model-configuration-title">Models and team</h2>
          <p className="muted">
            Assign a model to each specialty. SABRE retains control of the flow, memory and permissions.
          </p>
        </div>
        <button
          type="button"
          className="button small"
          disabled={loading || saving}
          onClick={() => void load()}
        >
          Refresh models
        </button>
      </div>
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
      {loading && !saved && <p role="status">Loading models…</p>}
      {saved && general && (
        <>
          <ul className="model-runners" aria-label="Runner sessions">
            {saved.runners.map((runner) => (
              <li key={runner.provider}>
                <strong>
                  {providers[runner.provider as ModelSelection['provider']]?.title ?? runner.provider}
                </strong>
                <span>
                  {runner.busy
                    ? 'Busy · session not checked'
                    : !runner.available
                      ? 'Runner unavailable'
                      : runner.authenticated
                        ? 'Session connected'
                        : 'Session connection required'}
                </span>
                {runner.error_code === 'CLAUDE_POLICY_UNSUPPORTED' && (
                  <small>Use an account supported by the official CLI and your organization policies.</small>
                )}
                {!runner.busy &&
                  runner.authenticated !== true &&
                  runner.error_code !== 'CLAUDE_POLICY_UNSUPPORTED' && (
                    <small>
                      {runner.provider === 'claude_cli'
                        ? 'Connect from the SABRE terminal: node infra/ops.mjs claude-login'
                        : 'Connect from the SABRE terminal: node infra/ops.mjs codex-login'}
                    </small>
                  )}
              </li>
            ))}
          </ul>
          <form onSubmit={(event) => void submit(event)}>
            <fieldset disabled={loading || saving} className="model-settings">
              <legend>Team configuration · revision {saved.revision}</legend>
              <details open className="model-role">
                <summary>
                  <strong>Default model</strong>
                  <span>
                    {providers[general.provider].title} · {general.name || 'CLI default'}
                  </span>
                </summary>
                <SelectionFields
                  value={general}
                  onChange={(value) => {
                    setGeneral(value);
                    setApproved(false);
                    setNotice('');
                  }}
                />
              </details>
              {saved.roles.map((role) => {
                const value = overrides[role.role] ?? null;
                const effective = value ?? general;
                return (
                  <details className="model-role" key={role.role}>
                    <summary>
                      <strong>{roles[role.role] ?? role.role}</strong>
                      <span>
                        {value ? providers[effective.provider].title : 'Inherits the default model'} ·{' '}
                        {effective.name || 'CLI default'}
                      </span>
                    </summary>
                    <label className="model-inherit">
                      <input
                        type="checkbox"
                        checked={!value}
                        onChange={(event) => change(role.role, event.target.checked ? null : { ...general })}
                      />
                      Inherit the default model
                    </label>
                    {value && <SelectionFields value={value} onChange={(next) => change(role.role, next)} />}
                    {role.credential_target && (
                      <p className="muted">
                        Saved credential target: <code>{role.credential_target}</code>. Manage keys in the
                        model connection.
                      </p>
                    )}
                  </details>
                );
              })}
              <div className="model-destinations">
                <p>Team destinations for this configuration</p>
                <ul>
                  {destinations.map((destination) => (
                    <li key={destination}>
                      <code>{destination || 'Destination required'}</code>
                    </li>
                  ))}
                </ul>
                <label className="model-inherit">
                  <input
                    type="checkbox"
                    checked={approved}
                    onChange={(event) => setApproved(event.target.checked)}
                  />
                  I authorize sending each role context to its listed destinations.
                </label>
              </div>
              <div className="integration-actions">
                <button type="submit" className="button primary" disabled={!dirty || !approved || saving}>
                  {saving ? 'Saving…' : 'Save models'}
                </button>
                {dirty && (
                  <button
                    type="button"
                    className="button"
                    onClick={() => {
                      accept(saved);
                      setNotice('');
                    }}
                  >
                    Descartar cambios
                  </button>
                )}
              </div>
              <p className="muted">
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
