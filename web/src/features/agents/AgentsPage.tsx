import { lazy } from 'react';
import { Bot } from 'lucide-react';
import type { Api, Project, WorkOrder } from '../../api';
import PageHeader from '../../components/PageHeader';
import StatTile, { StatGrid } from '../../components/StatTile';
import { isClosed, pendingQuestions } from '../../runState';
import ProductionLine from './ProductionLine';

const AgentsConsole = lazy(() => import('../../AgentsConsole'));
const WEEK = 7 * 86_400_000;

/** Agents: how the line runs, who works at each station, and the catalog behind them. */
export default function AgentsPage({
  api,
  projects,
  orders,
  connected,
  now,
}: {
  api: Api;
  projects: Project[];
  orders: WorkOrder[];
  connected: boolean;
  now: number;
}) {
  const open = orders.filter((order) => !isClosed(order));
  const questions = open.reduce((sum, order) => sum + pendingQuestions(order).length, 0);
  const recent = orders.filter((order) => now - new Date(order.updated_at).getTime() <= WEEK);
  const repairs = recent.reduce((sum, order) => sum + order.repair_cycles_used, 0);
  const stopped = open.filter((order) => order.status === 'blocked' || order.status === 'failed').length;
  return (
    <div className="grid min-w-0 gap-6">
      <PageHeader
        icon={<Bot />}
        title="Agents"
        description="A fixed production line with rule-based branches. No model chooses the route: the flow, the gates and your answers do."
      />
      <StatGrid label="Agents summary">
        <StatTile
          label="On the line"
          value={open.length}
          tone={open.length ? 'primary' : 'default'}
          note={open.length === 1 ? '1 open run' : `${open.length} open runs`}
        />
        <StatTile
          label="Waiting on you"
          value={questions}
          tone={questions ? 'warning' : 'default'}
          note={questions ? 'Answer from the run page' : 'No questions open'}
        />
        <StatTile
          label="Repair cycles · 7 days"
          value={repairs}
          note={`Across ${recent.length} run${recent.length === 1 ? '' : 's'}`}
        />
        <StatTile
          label="Stopped"
          value={stopped}
          tone={stopped ? 'danger' : 'default'}
          note={stopped ? 'Blocked or failed, resumable' : 'Nothing blocked'}
        />
      </StatGrid>
      <ProductionLine api={api} orders={orders} />
      <AgentsConsole api={api} projects={projects} connected={connected} />
    </div>
  );
}
