import { lazy, useEffect, useState } from 'react';
import { Bot } from 'lucide-react';
import type { AgentActivity, Api, Project, WorkOrder } from '../../api';
import PageHeader from '../../components/PageHeader';
import StatTile, { StatGrid } from '../../components/StatTile';
import { isClosed, pendingQuestions } from '../../runState';
import { crewLabel } from '../crew/CrewAvatar';
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
  const [activity, setActivity] = useState<AgentActivity | null>(null);
  useEffect(() => {
    let live = true;
    void api
      .agentActivity(7)
      .then((value) => live && setActivity(Array.isArray(value?.roles) ? value : null))
      .catch(() => live && setActivity(null));
    return () => {
      live = false;
    };
  }, [api, now]);
  const open = orders.filter((order) => !isClosed(order));
  const questions = open.reduce((sum, order) => sum + pendingQuestions(order).length, 0);
  const recent = orders.filter((order) => now - new Date(order.updated_at).getTime() <= WEEK);
  const repairs = activity?.repair_cycles ?? recent.reduce((sum, order) => sum + order.repair_cycles_used, 0);
  const invocations = activity?.roles.reduce((sum, role) => sum + role.invocations, 0) ?? null;
  const failed = activity?.roles.reduce((sum, role) => sum + role.failed, 0) ?? 0;
  const busiest = activity?.roles.reduce<AgentActivity['roles'][number] | null>(
    (best, role) => (!best || role.invocations > best.invocations ? role : best),
    null,
  );
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
          label="Invocations · 7 days"
          value={invocations ?? '—'}
          tone={failed ? 'danger' : 'default'}
          note={
            invocations == null
              ? 'Activity not reported by this server'
              : busiest && busiest.invocations
                ? `${failed} failed · busiest ${crewLabel(busiest.role)}`
                : 'No specialist ran this week'
          }
        />
        <StatTile
          label="Repair cycles · 7 days"
          value={repairs}
          note={`Across ${recent.length} run${recent.length === 1 ? '' : 's'}`}
        />
      </StatGrid>
      {activity && activity.roles.some((role) => role.invocations > 0) && (
        <section aria-labelledby="agents-activity-title" className="grid gap-2">
          <h2 id="agents-activity-title" className="text-sm font-semibold">
            Work by role · last 7 days
          </h2>
          <ul className="flex flex-wrap gap-2">
            {activity.roles
              .filter((role) => role.invocations > 0)
              .sort((a, b) => b.invocations - a.invocations)
              .map((role) => (
                <li
                  key={role.role}
                  className="grid min-w-36 gap-0.5 rounded-lg border border-border bg-card px-3 py-2 text-xs"
                >
                  <strong className="text-sm font-semibold">{crewLabel(role.role)}</strong>
                  <span className="text-muted-foreground tabular-nums">
                    {role.invocations} calls · {role.completed} done
                    {role.failed ? ` · ${role.failed} failed` : ''}
                  </span>
                  <span className="text-muted-foreground tabular-nums">
                    {Math.round(role.duration_ms / 1000)} s
                    {role.tokens == null
                      ? ' · tokens not reported'
                      : ` · ${role.tokens.toLocaleString('en-US')} tokens`}
                  </span>
                </li>
              ))}
          </ul>
        </section>
      )}
      <ProductionLine api={api} orders={orders} />
      <AgentsConsole api={api} projects={projects} connected={connected} />
    </div>
  );
}
