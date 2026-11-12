import { useId } from 'react';
import type { Project, WorkOrder } from './api';
import './WorkBoard.css';
import StatusBadge from './components/StatusBadge';

const columns: { id: string; label: string; statuses: WorkOrder['status'][] }[] = [
  { id: 'pending', label: 'Pending', statuses: ['queued'] },
  { id: 'running', label: 'Running', statuses: ['running'] },
  { id: 'waiting', label: 'Waiting', statuses: ['waiting_input', 'paused', 'blocked', 'failed'] },
  { id: 'finished', label: 'Finished', statuses: ['completed', 'cancelled'] },
];
const statusLabels: Record<WorkOrder['status'], string> = {
  queued: 'Queued',
  running: 'Running',
  waiting_input: 'Decision needed',
  paused: 'Paused',
  blocked: 'Blocked',
  failed: 'Failed',
  completed: 'Completed',
  cancelled: 'Cancelled',
};
const modeLabels: Record<WorkOrder['mode'], string> = {
  create: 'Create',
  maintain: 'Maintain',
  patch: 'Patch',
  audit: 'Audit',
};
const phaseLabels: Record<string, string> = {
  intake: 'Preparation',
  analysis: 'Analysis',
  clarification: 'Clarification',
  design: 'Design',
  plan: 'Planning',
  planning: 'Planning',
  implementation: 'Implementation',
  verification: 'Checks',
  review: 'Review',
  security: 'Security',
  security_watch: 'Security monitoring',
  delivery: 'Entrega',
  deliver: 'Entrega',
  prepare_delivery: 'Prepare delivery',
  remember: 'Memory',
};

export default function WorkBoard({
  orders,
  projects,
  onOpen,
}: {
  orders: WorkOrder[];
  projects: Project[];
  onOpen: (order: WorkOrder) => void;
}) {
  const id = useId();
  return (
    <div className="work-board" role="region" aria-label="Run board">
      {columns.map((column) => {
        const items = orders.filter((order) => column.statuses.includes(order.status));
        return (
          <section
            className={`work-board-column work-board-${column.id}`}
            key={column.id}
            aria-labelledby={`${id}-${column.id}`}
          >
            <header>
              <h2 id={`${id}-${column.id}`}>{column.label}</h2>
              <span aria-label={`${items.length} runs`}>{items.length}</span>
            </header>
            {items.length === 0 ? (
              <p className="work-board-empty">No runs in this state</p>
            ) : (
              <ul>
                {items.map((order) => (
                  <li key={order.id}>
                    <button className="work-board-card" onClick={() => onOpen(order)}>
                      <span className="work-board-project">
                        {projects.find((project) => project.id === order.project_id)?.name ??
                          'Project unavailable'}
                      </span>
                      <span className="work-board-kind">
                        {order.phase === 'security_watch' ? 'Security monitoring' : modeLabels[order.mode]}
                      </span>
                      <strong>{order.objective}</strong>
                      <StatusBadge value={order.status} label={statusLabels[order.status]} />
                      <span className="work-board-phase">
                        Etapa: {phaseLabels[order.phase] ?? order.phase}
                      </span>
                      {order.summary && <span className="work-board-summary">{order.summary}</span>}
                      <span className="work-board-open">View run →</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        );
      })}
    </div>
  );
}
