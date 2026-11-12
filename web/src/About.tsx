import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { Api, SystemInfo } from './api';
import Icon from './Icon';
import Button from './components/Button';
import Notice from './components/Notice';
import LoadingState from './components/LoadingState';
import { SectionHeading } from './components/PageHeader';

const states = {
  available: 'Responding',
  unavailable: 'Unavailable',
  busy: 'Busy',
  unknown: 'Not checked',
};
const roles: Record<string, string> = {
  supervisor: 'Supervisor',
  analyst: 'Analyst',
  architect: 'Architect',
  developer: 'Developer',
  qa: 'Verification engineer',
  reviewer: 'Technical reviewer',
  security: 'Security analyst',
};

const stateTones: Record<keyof typeof states, string> = {
  available: 'text-success',
  unavailable: 'text-danger',
  busy: 'text-warning',
  unknown: 'text-muted-foreground',
};
const section = 'grid min-w-0 gap-3';
/** Two columns of bordered rows on wide containers, one on narrow ones. */
const grid = 'grid min-w-0 gap-x-7 @3xl:grid-cols-2';

function Fact({ term, children }: { term: ReactNode; children: ReactNode }) {
  return (
    <div className="flex min-w-0 justify-between gap-4 border-b border-border py-3 text-sm">
      <dt className="text-muted-foreground [overflow-wrap:anywhere]">{term}</dt>
      <dd className="text-right tabular-nums [overflow-wrap:anywhere]">{children}</dd>
    </div>
  );
}

const runningBuild: string = import.meta.env.VITE_SABRE_BUILD ?? 'development';

export default function About({ api }: { api: Pick<Api, 'system'> }) {
  const [servedBuild, setServedBuild] = useState<string | null>(null);
  useEffect(() => {
    if (runningBuild === 'development') return;
    let active = true;
    // Compare with what the server serves now; a mismatch means this tab runs an older bundle.
    fetch('/build.json', { cache: 'no-store', credentials: 'omit' })
      .then((response) => (response.ok ? (response.json() as Promise<{ build?: unknown }>) : null))
      .then((value) => {
        if (active && typeof value?.build === 'string') setServedBuild(value.build);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);
  const [info, setInfo] = useState<SystemInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const initial = useRef<{ api: typeof api; promise: Promise<SystemInfo> } | null>(null);
  useEffect(() => {
    let active = true;
    // StrictMode must not duplicate the session probe; there is no periodic polling here.
    if (initial.current?.api !== api) initial.current = { api, promise: api.system() };
    initial.current.promise.then(
      (value) => {
        if (active) {
          setInfo(value);
          setFailed(false);
          setLoading(false);
        }
      },
      () => {
        if (active) {
          setFailed(true);
          setLoading(false);
        }
      },
    );
    return () => {
      active = false;
    };
  }, [api]);

  async function refresh() {
    setLoading(true);
    setFailed(false);
    try {
      setInfo(await api.system());
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }

  return (
    <section className="@container grid min-w-0 gap-6" aria-label="System information" aria-busy={loading}>
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-3">
        <p className="max-w-[74ch] text-sm text-muted-foreground">
          Installed versions and verification coverage for this instance.
        </p>
        <Button variant="secondary" onClick={() => void refresh()} disabled={loading}>
          <Icon name="refresh" /> {loading ? 'Checking…' : 'Refresh system'}
        </Button>
      </div>
      {failed && (
        <Notice tone="danger" role="alert">
          {info
            ? 'System refresh failed. Previous results remain visible.'
            : 'The system could not be queried. Check the connection and retry.'}
        </Notice>
      )}
      {!info && loading && <LoadingState label="Loading instance status…" />}
      {info && (
        <>
          <div className="flex min-w-0 flex-wrap items-end justify-between gap-3 border-b border-border pb-6">
            <div className="grid min-w-0 gap-1.5">
              <h2 className="text-2xl font-semibold tracking-tight [overflow-wrap:anywhere]">
                {info.application.name}
              </h2>
              <p className="text-sm text-muted-foreground [overflow-wrap:anywhere]">
                Version {info.application.version ?? 'unknown'} · Graph {info.application.graph_version}
              </p>
            </div>
            <p className="text-xs text-muted-foreground @xl:text-right">
              Last checked
              <br />
              <time dateTime={info.checked_at} className="text-foreground">
                {new Date(info.checked_at).toLocaleString('en-US')}
              </time>
            </p>
          </div>

          <section className={section} aria-labelledby="system-components-title">
            <SectionHeading
              id="system-components-title"
              title="Services and connections"
              description="Saved configuration does not prove availability. Each row describes what was checked."
            />
            <ul className={grid}>
              {info.components.map((component) => (
                <li
                  key={component.id}
                  className="grid min-w-0 content-start gap-1 border-b border-border py-4"
                >
                  <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                    <h3 className="text-sm font-semibold">{component.label}</h3>
                    <span className={`text-xs whitespace-nowrap ${stateTones[component.state]}`}>
                      {states[component.state]}
                    </span>
                  </div>
                  {component.configured !== null && (
                    <span className="text-xs text-muted-foreground">
                      {component.configured ? 'Configured' : 'Not configured'}
                    </span>
                  )}
                  <p className="text-sm text-muted-foreground">{component.detail}</p>
                </li>
              ))}
            </ul>
          </section>

          <section className={section} aria-labelledby="system-limits-title">
            <SectionHeading id="system-limits-title" title="Execution capacity" />
            <dl className={grid}>
              <Fact term="Concurrent runs">{info.limits.concurrent_work}</Fact>
              <Fact term="Writers per repository">{info.limits.writers_per_repository}</Fact>
              <Fact term="Repair cycles per task">{info.limits.repair_cycles}</Fact>
              {info.limits.codex_invocations !== null && (
                <Fact term="Concurrent Codex invocations">{info.limits.codex_invocations}</Fact>
              )}
              {info.limits.claude_invocations != null && (
                <Fact term="Concurrent Claude invocations">{info.limits.claude_invocations}</Fact>
              )}
            </dl>
            {info.limits.codex_invocations !== null && (
              <p className="max-w-[74ch] text-sm text-muted-foreground">
                Runs can progress across projects; the Codex runner processes one invocation at a time.
              </p>
            )}
          </section>

          <section className={section} aria-labelledby="system-models-title">
            <SectionHeading
              id="system-models-title"
              title="Team and models"
              description="Current role configuration. Individual runs retain their launch configuration."
            />
            <dl className={grid}>
              {info.models.map((model) => (
                <Fact key={model.role} term={roles[model.role] ?? model.role}>
                  <span>
                    {model.provider} ·{' '}
                    {model.name ||
                      (model.provider === 'codex_cli' ? 'Automatic (CLI)' : 'Provider default model')}
                  </span>
                  <small className="mt-1 block text-xs text-muted-foreground">
                    {model.configured === null
                      ? 'Session not checked: runner busy'
                      : model.configured
                        ? 'Configured'
                        : 'Not configured'}
                  </small>
                </Fact>
              ))}
            </dl>
          </section>

          <section className={section} aria-labelledby="system-versions-title">
            <SectionHeading
              id="system-versions-title"
              title="Environment and versions"
              description="API process information. The pgvector library version does not identify the extension installed in PostgreSQL."
            />
            <dl className={grid}>
              <Fact term="Console build">
                <code className="font-mono text-xs">{runningBuild}</code>
                {servedBuild && servedBuild !== runningBuild && (
                  <span role="status">
                    {' '}
                    · The server now serves build <code className="font-mono text-xs">{servedBuild}</code>.
                    Reload to use it.
                  </span>
                )}
              </Fact>
              <Fact term="Python">
                {info.runtime.python} · {info.runtime.implementation}
              </Fact>
              <Fact term="Backend platform">
                {info.runtime.system} · {info.runtime.architecture}
              </Fact>
              {info.packages.map((item) => (
                <Fact key={item.distribution} term={item.distribution}>
                  {item.version ?? 'Unknown'}
                </Fact>
              ))}
            </dl>
          </section>
        </>
      )}
    </section>
  );
}
