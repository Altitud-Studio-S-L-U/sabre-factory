import { useEffect, useRef, useState } from 'react';
import type { Api, SystemInfo } from './api';
import Icon from './Icon';
import './About.css';

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
    <section className="system-about" aria-label="System information" aria-busy={loading}>
      <div className="system-about-toolbar">
        <p>Installed versions and verification coverage for this instance.</p>
        <button className="button secondary" onClick={() => void refresh()} disabled={loading}>
          <Icon name="refresh" /> {loading ? 'Checking…' : 'Refresh system'}
        </button>
      </div>
      {failed && (
        <p className="notice error" role="alert">
          {info
            ? 'System refresh failed. Previous results remain visible.'
            : 'The system could not be queried. Check the connection and retry.'}
        </p>
      )}
      {!info && loading && (
        <p role="status" className="system-about-loading">
          Loading instance status…
        </p>
      )}
      {info && (
        <>
          <div className="system-about-identity">
            <div>
              <h2>{info.application.name}</h2>
              <p>
                Version {info.application.version ?? 'unknown'} · Graph {info.application.graph_version}
              </p>
            </div>
            <p className="system-about-time">
              Last checked
              <br />
              <time dateTime={info.checked_at}>{new Date(info.checked_at).toLocaleString('en-US')}</time>
            </p>
          </div>

          <section className="system-about-section" aria-labelledby="system-components-title">
            <h2 id="system-components-title">Services and connections</h2>
            <p>Saved configuration does not prove availability. Each row describes what was checked.</p>
            <ul className="system-components">
              {info.components.map((component) => (
                <li key={component.id}>
                  <div className="system-component-title">
                    <h3>{component.label}</h3>
                    <span className={`system-state system-state-${component.state}`}>
                      {states[component.state]}
                    </span>
                  </div>
                  {component.configured !== null && (
                    <span className="system-component-config">
                      {component.configured ? 'Configured' : 'Not configured'}
                    </span>
                  )}
                  <p>{component.detail}</p>
                </li>
              ))}
            </ul>
          </section>

          <section className="system-about-section" aria-labelledby="system-limits-title">
            <h2 id="system-limits-title">Execution capacity</h2>
            <dl className="system-facts">
              <div>
                <dt>Concurrent runs</dt>
                <dd>{info.limits.concurrent_work}</dd>
              </div>
              <div>
                <dt>Writers per repository</dt>
                <dd>{info.limits.writers_per_repository}</dd>
              </div>
              <div>
                <dt>Repair cycles per task</dt>
                <dd>{info.limits.repair_cycles}</dd>
              </div>
              {info.limits.codex_invocations !== null && (
                <div>
                  <dt>Concurrent Codex invocations</dt>
                  <dd>{info.limits.codex_invocations}</dd>
                </div>
              )}
              {info.limits.claude_invocations != null && (
                <div>
                  <dt>Concurrent Claude invocations</dt>
                  <dd>{info.limits.claude_invocations}</dd>
                </div>
              )}
            </dl>
            {info.limits.codex_invocations !== null && (
              <p>Runs can progress across projects; the Codex runner processes one invocation at a time.</p>
            )}
          </section>

          <section className="system-about-section" aria-labelledby="system-models-title">
            <h2 id="system-models-title">Team and models</h2>
            <p>Current role configuration. Individual runs retain their launch configuration.</p>
            <dl className="system-facts system-models">
              {info.models.map((model) => (
                <div key={model.role}>
                  <dt>{roles[model.role] ?? model.role}</dt>
                  <dd>
                    <span>
                      {model.provider} ·{' '}
                      {model.name ||
                        (model.provider === 'codex_cli' ? 'Automatic (CLI)' : 'Provider default model')}
                    </span>
                    <small>
                      {model.configured === null
                        ? 'Session not checked: runner busy'
                        : model.configured
                          ? 'Configured'
                          : 'Not configured'}
                    </small>
                  </dd>
                </div>
              ))}
            </dl>
          </section>

          <section className="system-about-section" aria-labelledby="system-versions-title">
            <h2 id="system-versions-title">Environment and versions</h2>
            <p>
              API process information. The pgvector library version does not identify the extension installed
              in PostgreSQL.
            </p>
            <dl className="system-facts">
              <div>
                <dt>Console build</dt>
                <dd>
                  <code>{runningBuild}</code>
                  {servedBuild && servedBuild !== runningBuild && (
                    <span role="status">
                      {' '}
                      · The server now serves build <code>{servedBuild}</code>. Reload to use it.
                    </span>
                  )}
                </dd>
              </div>
              <div>
                <dt>Python</dt>
                <dd>
                  {info.runtime.python} · {info.runtime.implementation}
                </dd>
              </div>
              <div>
                <dt>Backend platform</dt>
                <dd>
                  {info.runtime.system} · {info.runtime.architecture}
                </dd>
              </div>
              {info.packages.map((item) => (
                <div key={item.distribution}>
                  <dt>{item.distribution}</dt>
                  <dd>{item.version ?? 'Unknown'}</dd>
                </div>
              ))}
            </dl>
          </section>
        </>
      )}
    </section>
  );
}
