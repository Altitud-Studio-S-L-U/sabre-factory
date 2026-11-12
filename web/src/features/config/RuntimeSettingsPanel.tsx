import { useEffect, useState, type ReactNode } from 'react';
import { Lock } from 'lucide-react';
import type { Api, ConfigurationHistory, RuntimeSettings } from '../../api';
import LoadingState from '../../components/LoadingState';
import Notice from '../../components/Notice';
import { Card } from '../../components/ui/card';
import { message } from '../runs/shared';

type Row = { name: string; value: ReactNode; source: string | null; note?: string };

function rows(settings: RuntimeSettings): { title: string; description: string; rows: Row[] }[] {
  const money = (value: number) => (value > 0 ? `USD ${value.toFixed(2)}` : 'Not set');
  const sandbox = settings.sandbox;
  return [
    {
      title: 'Execution',
      description: 'How much work runs at once, and the box every command runs in.',
      rows: [
        {
          name: 'Execution slots',
          value: settings.execution_slots.value,
          source: settings.execution_slots.env_var,
        },
        { name: 'Memory per command', value: sandbox.memory.value, source: sandbox.memory.env_var },
        { name: 'CPUs per command', value: sandbox.cpus.value, source: sandbox.cpus.env_var },
        { name: 'Processes per command', value: sandbox.pids.value, source: sandbox.pids.env_var },
        {
          name: 'Command timeout',
          value: `${sandbox.default_timeout_s.value} s · up to ${sandbox.max_timeout_s.value} s`,
          source: sandbox.default_timeout_s.env_var,
        },
        {
          name: 'Network by default',
          value: sandbox.network_default.value === 'none' ? 'None' : sandbox.network_default.value,
          source: sandbox.network_default.env_var,
        },
      ],
    },
    {
      title: 'Spend',
      description: 'Ceilings above every run budget.',
      rows: [
        {
          name: 'Monthly spend cap',
          value: money(settings.monthly_budget_usd.value),
          source: settings.monthly_budget_usd.env_var,
        },
        {
          name: 'Supervisor chat cap',
          value: money(settings.chat_budget_usd.value),
          source: settings.chat_budget_usd.env_var,
        },
      ],
    },
    {
      title: 'Access',
      description: 'Who can reach this console and for how long a paired browser stays signed in.',
      rows: [
        {
          name: 'Allowed origins',
          value: settings.allowed_origins.value.length ? settings.allowed_origins.value.join(', ') : 'None',
          source: settings.allowed_origins.env_var,
        },
        {
          name: 'Paired browser sessions',
          value: `${settings.panel_session_days.value} days`,
          source: settings.panel_session_days.env_var,
        },
      ],
    },
    {
      title: 'Notifications and telemetry',
      description: 'Where the factory reports what happened. Signing keys stay in the credential store.',
      rows: [
        {
          name: 'Webhooks',
          value: settings.webhooks.value.length ? settings.webhooks.value.join(', ') : 'None',
          source: settings.webhooks.env_var,
        },
        {
          name: 'Traces',
          value: settings.otlp.configured
            ? `Sent to ${settings.otlp.host ?? 'a configured collector'}`
            : 'Off',
          source: settings.otlp.env_var,
        },
      ],
    },
  ];
}

/**
 * Settings the running instance reads from its environment. They are shown, never edited here:
 * changing one means editing .env and restarting, which the panel cannot and should not do.
 */
export function RuntimeSettingsPanel({ api }: { api: Api }) {
  const [state, setState] = useState<{ settings?: RuntimeSettings | null; error?: string } | null>(null);
  useEffect(() => {
    let live = true;
    void api
      .system()
      .then((info) => live && setState({ settings: info.runtime_settings ?? null }))
      .catch((error: unknown) => live && setState({ error: message(error) }));
    return () => {
      live = false;
    };
  }, [api]);
  if (!state) return <LoadingState label="Reading the instance settings…" />;
  if (state.error)
    return (
      <Notice tone="danger" role="alert">
        {state.error}
      </Notice>
    );
  if (!state.settings)
    return (
      <Notice tone="neutral" title="This server does not report its runtime settings.">
        <p>Update SABRE to see which environment variables shape this instance.</p>
      </Notice>
    );
  return (
    <div className="grid min-w-0 gap-4">
      <Notice tone="neutral" title="Set by the environment">
        <p>
          Read-only here. Change <code>.env</code> and restart with <code>sabre up</code>. Values marked fixed
          are part of the executor and change only with a new release.
        </p>
      </Notice>
      {rows(state.settings).map((group) => (
        <Card key={group.title} aria-labelledby={`runtime-${group.title}`} className="gap-3">
          <div className="grid gap-0.5">
            <h2 id={`runtime-${group.title}`} className="text-base font-semibold">
              {group.title}
            </h2>
            <p className="text-xs text-muted-foreground">{group.description}</p>
          </div>
          <dl className="grid divide-y divide-border border-y border-border">
            {group.rows.map((row) => (
              <div
                key={row.name}
                className="grid min-w-0 gap-1 py-2.5 text-sm sm:grid-cols-[minmax(0,14rem)_minmax(0,1fr)_auto] sm:items-center sm:gap-4"
              >
                <dt className="text-muted-foreground">{row.name}</dt>
                <dd className="min-w-0 font-medium [overflow-wrap:anywhere]">{row.value}</dd>
                <dd className="flex items-center gap-1.5 font-mono text-xs text-muted-foreground">
                  <Lock aria-hidden="true" className="size-3" />
                  {row.source ?? 'Fixed in the executor'}
                </dd>
              </div>
            ))}
          </dl>
        </Card>
      ))}
    </div>
  );
}

/** Saved configuration revisions with what each one changed. */
export function ConfigurationHistoryPanel({ api, revision }: { api: Api; revision: number }) {
  const [state, setState] = useState<{ key: number; history?: ConfigurationHistory; error?: string } | null>(
    null,
  );
  useEffect(() => {
    let live = true;
    void api
      .configurationHistory(30)
      .then((history) => live && setState({ key: revision, history }))
      .catch((error: unknown) => live && setState({ key: revision, error: message(error) }));
    return () => {
      live = false;
    };
  }, [api, revision]);
  const current = state?.key === revision ? state : null;
  if (!current) return <LoadingState label="Loading revisions…" />;
  if (current.error)
    return (
      <Notice tone="danger" role="alert">
        {current.error}
      </Notice>
    );
  const items = current.history?.items ?? [];
  return (
    <Card aria-labelledby="config-history-title" className="gap-3">
      <div className="grid gap-0.5">
        <h2 id="config-history-title" className="text-base font-semibold">
          Revision history
        </h2>
        <p className="text-xs text-muted-foreground">
          Every saved revision. Runs pin the revision that was current when they started.
        </p>
      </div>
      {items.length ? (
        <ol className="grid divide-y divide-border border-y border-border">
          {items.map((item) => (
            <li key={item.revision} className="grid gap-1.5 py-3 text-sm">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <strong className="font-semibold">
                  Revision {item.revision}
                  {item.revision === revision && (
                    <span className="ml-2 text-xs font-normal text-primary">current</span>
                  )}
                </strong>
                <time dateTime={item.created_at} className="text-xs text-muted-foreground">
                  {new Date(item.created_at).toLocaleString('en-US')} · you
                </time>
              </div>
              <p className="text-muted-foreground">{item.summary}</p>
              {item.changed_paths.length > 0 && (
                <span className="flex flex-wrap gap-1">
                  {item.changed_paths.map((path) => (
                    <code key={path} className="rounded bg-secondary px-1.5 py-0.5 text-xs">
                      {path}
                    </code>
                  ))}
                  {item.changed_paths_truncated && (
                    <span className="text-xs text-muted-foreground">and more</span>
                  )}
                </span>
              )}
            </li>
          ))}
        </ol>
      ) : (
        <p className="text-sm text-muted-foreground">No revision has been saved yet.</p>
      )}
    </Card>
  );
}
