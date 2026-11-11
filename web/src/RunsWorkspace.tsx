import { useState, type ReactNode } from 'react';
import type { Project, WorkOrder } from './api';
import Select from './components/Select';
import './RunsWorkspace.css';

export default function RunsWorkspace({
  orders,
  projects,
  selectedId,
  onOpen,
  onNew,
  connected = true,
  children,
}: {
  orders: WorkOrder[];
  projects: Project[];
  selectedId?: string | null;
  onOpen: (order: WorkOrder) => void;
  onNew: () => void;
  connected?: boolean;
  children: ReactNode;
}) {
  const [query, setQuery] = useState('');
  const [projectId, setProjectId] = useState('');
  const [state, setState] = useState('all');
  const visible = orders.filter(
    (order) =>
      (!projectId || order.project_id === projectId) &&
      (!query ||
        `${order.objective} ${order.id} ${projects.find((project) => project.id === order.project_id)?.name ?? ''}`
          .toLocaleLowerCase()
          .includes(query.toLocaleLowerCase())) &&
      (state === 'all' ||
        (state === 'active' && ['queued', 'running'].includes(order.status)) ||
        (state === 'attention' && ['blocked', 'failed', 'waiting_input', 'paused'].includes(order.status)) ||
        (state === 'finished' && ['completed', 'cancelled'].includes(order.status))),
  );
  return (
    <div className="runs-workspace">
      <aside className="runs-rail" aria-label="Runs">
        <header>
          <div>
            <h1 tabIndex={-1}>Runs</h1>
            <span>{orders.length} recorded</span>
          </div>
          <button type="button" className="button small primary" onClick={onNew} disabled={!connected}>
            + New run
          </button>
        </header>
        <label className="sr-only" htmlFor="run-search">
          Search runs
        </label>
        <input
          id="run-search"
          type="search"
          placeholder="Find a run or objective…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <label className="runs-rail-filter">
          Project
          <Select value={projectId} onChange={(event) => setProjectId(event.target.value)}>
            <option value="">All projects</option>
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </Select>
        </label>
        <div className="run-state-filter" aria-label="Filter runs">
          {[
            ['all', 'All'],
            ['active', 'Active'],
            ['attention', 'Attention'],
            ['finished', 'Closed'],
          ].map(([value, label]) => (
            <button type="button" key={value} aria-pressed={state === value} onClick={() => setState(value)}>
              {label}
            </button>
          ))}
        </div>
        <div className="runs-rail-list">
          {visible.map((order) => (
            <button
              type="button"
              className={`run-rail-item status-${order.status}`}
              key={order.id}
              aria-pressed={selectedId === order.id}
              onClick={() => onOpen(order)}
            >
              <div>
                <strong>
                  {projects.find((project) => project.id === order.project_id)?.name ?? 'Project'}
                </strong>
                <span>{order.mode}</span>
              </div>
              <p>{order.objective}</p>
              <footer>
                <span>
                  <i />
                  {order.status.replaceAll('_', ' ')}
                </span>
                <time>
                  {new Date(order.updated_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </time>
              </footer>
            </button>
          ))}
        </div>
        {!visible.length && (
          <div className="runs-rail-empty">
            <strong>{orders.length ? 'No matching runs' : 'Your factory is ready for its first run'}</strong>
            <p>
              {orders.length
                ? 'Change the filters to find another execution.'
                : 'Connect a project, choose a flow and define its acceptance checks.'}
            </p>
          </div>
        )}
        <footer className="runs-rail-footer">
          <span>One writer per project</span>
          <span>PR delivery requires verified evidence</span>
        </footer>
      </aside>
      <section className="run-workspace-main" aria-label="Selected run">
        {children}
      </section>
    </div>
  );
}
