import type { Project, WorkOrder } from './api';
import './FactoryOverview.css';
import Icon from './Icon';

const stages = [
  { title: 'Understand', role: 'Analyst', phases: ['intake', 'analysis', 'analyze', 'clarification'] },
  {
    title: 'Design',
    role: 'Architect',
    phases: ['design', 'architecture', 'design_clarification', 'architecture_approval'],
  },
  { title: 'Plan', role: 'Supervisor', phases: ['plan', 'planning', 'plan_clarification'] },
  {
    title: 'Build',
    role: 'Developer',
    phases: ['implement', 'implementation', 'repair', 'task_clarification', 'scope_check', 'scope_approval'],
  },
  {
    title: 'Verify',
    role: 'Verification and review',
    phases: ['verify', 'verification', 'qa_clarification'],
  },
  { title: 'Review', role: 'Technical reviewer', phases: ['review', 'review_clarification', 'decision'] },
  {
    title: 'Deliver',
    role: 'Controlled publication',
    phases: ['prepare_delivery', 'ready', 'delivery', 'deliver', 'remember'],
  },
];
const labels: Record<string, string> = {
  queued: 'Queued',
  running: 'Running',
  waiting_input: 'Decision needed',
  paused: 'Paused',
  blocked: 'Blocked',
  failed: 'Failed',
};
const terminal = new Set(['completed', 'cancelled']);
const securityPhases = new Set(['security', 'security_watch']);

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export default function FactoryOverview({
  orders,
  projects,
  status,
  onOpen,
  onView,
}: {
  orders: WorkOrder[];
  projects: Project[];
  status: Record<string, unknown>;
  onOpen: (order: WorkOrder) => void;
  onView: (view: 'settings' | 'memory' | 'security') => void;
}) {
  const active = orders.filter((order) => !terminal.has(order.status));
  const security = active.filter((order) => securityPhases.has(order.phase));
  const other = active.filter(
    (order) =>
      !securityPhases.has(order.phase) && !stages.some((stage) => stage.phases.includes(order.phase)),
  );
  const roles = record(status.roles);
  const cli = record(record(status.model).cli);
  const configuredRoles = Object.values(roles).filter((role) => record(role).configured === true).length;
  const memory = record(status.memory);
  const telemetry = record(status.telemetry);
  const projectName = (order: WorkOrder) =>
    projects.find((project) => project.id === order.project_id)?.name ?? 'Project';
  const orderButton = (order: WorkOrder) => (
    <button key={order.id} className={`line-order line-order-${order.status}`} onClick={() => onOpen(order)}>
      <span className="line-order-state">{labels[order.status] ?? order.status}</span>
      <strong>{projectName(order)}</strong>
      <span>{order.objective}</span>
    </button>
  );

  return (
    <section className="factory-line" aria-labelledby="factory-line-title">
      <div className="factory-line-heading">
        <div>
          <h2 id="factory-line-title">Production flow</h2>
          <p>Follow each run and the team carrying it out.</p>
        </div>
        <span className="line-caption">Roles activate according to the work</span>
      </div>
      <div className="factory-line-scroll" tabIndex={0} role="region" aria-label="Factory phases">
        <ol className="factory-stages">
          {stages.map((stage) => {
            const current = active.filter((order) => stage.phases.includes(order.phase));
            return (
              <li key={stage.title} className={current.length ? 'factory-stage occupied' : 'factory-stage'}>
                <div className="stage-node">
                  <span className="stage-indicator" aria-hidden="true" />
                  <h3>{stage.title}</h3>
                  {current.length > 0 && (
                    <span className="stage-count" aria-label={`${current.length} runs`}>
                      {current.length}
                    </span>
                  )}
                </div>
                <p className="stage-role">{stage.role}</p>
                {current.length ? current.map(orderButton) : <p className="stage-empty">No runs</p>}
              </li>
            );
          })}
        </ol>
      </div>
      <div className="factory-security-lane">
        <div>
          <h3>
            <Icon name="security" size={17} /> Security pipeline
          </h3>
          <p>Review deliveries and monitor projects. Findings can block publication.</p>
          <button className="text-button" onClick={() => onView('security')}>
            View findings and exceptions →
          </button>
        </div>
        <div className="security-lane-orders">
          {security.length ? security.map(orderButton) : <span>No security reviews in progress</span>}
        </div>
      </div>
      {other.length > 0 && (
        <div className="factory-unmapped">
          <h3>Other recorded phases</h3>
          {other.map(orderButton)}
        </div>
      )}
      <div className="factory-services">
        <button onClick={() => onView('settings')}>
          <strong>Team</strong>
          <span>
            {cli.busy === true
              ? 'Codex is processing an invocation'
              : cli.available === false
                ? 'Codex runner unavailable'
                : cli.authenticated === false
                  ? 'Codex session needs connection'
                  : Object.keys(roles).length
                    ? `${configuredRoles} of ${Object.keys(roles).length} configured roles`
                    : 'Configuration unavailable'}
          </span>
          <small>Models and connections →</small>
        </button>
        <button onClick={() => onView('memory')}>
          <strong>Memory</strong>
          <span>{memory.store ? 'Project knowledge' : 'Status unavailable'}</span>
          <small>
            {memory.semantic_search === true
              ? 'Text and vector search'
              : 'Text search · vector search not configured'}{' '}
            →
          </small>
        </button>
        <button onClick={() => onView('settings')}>
          <strong>Telemetry</strong>
          <span>
            {telemetry.configured === true ? 'Trace export configured' : 'Trace export not configured'}
          </span>
          <small>Each run's events are available in its detail view →</small>
        </button>
      </div>
    </section>
  );
}
