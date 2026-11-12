import { useCallback, useEffect, useState } from 'react';
import type { Api, Project, SecurityFinding, WorkOrder } from '../../api';
import Button from '../../components/Button';
import Field from '../../components/FormField';
import Select from '../../components/Select';
import Notice from '../../components/Notice';
import EmptyState from '../../components/EmptyState';
import LoadingState from '../../components/LoadingState';
import PageHeader from '../../components/PageHeader';
import { Findings } from '../runs/RunDetail';
import { ErrorNotice, message } from '../runs/shared';

export default function SecurityView({
  api,
  projects,
  orders,
}: {
  api: Api;
  projects: Project[];
  orders: WorkOrder[];
}) {
  const [projectId, setProjectId] = useState('');
  const [findings, setFindings] = useState<SecurityFinding[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const fetchFindings = useCallback(
    () =>
      api
        .security(projectId || undefined)
        .then((next) => {
          setFindings(next);
          setError('');
        })
        .catch((err: unknown) => {
          setFindings([]);
          setError(message(err));
        })
        .finally(() => setLoading(false)),
    [api, projectId],
  );
  const load = () => {
    setLoading(true);
    void fetchFindings();
  };
  useEffect(() => {
    void fetchFindings();
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void fetchFindings();
    }, 10000);
    return () => window.clearInterval(timer);
  }, [fetchFindings]);
  const scoped = orders.filter((order) => !projectId || order.project_id === projectId);
  return (
    <div className="grid gap-6">
      <PageHeader
        eyebrow="Independent review"
        title="Security"
        description="Security findings and blockers, independent from the development team."
        actions={
          <Button type="button" onClick={load} disabled={loading}>
            Refresh
          </Button>
        }
      />
      <div className="flex flex-wrap items-end justify-between gap-4">
        <Field label="Project" className="w-full max-w-80">
          <Select value={projectId} onChange={(event) => setProjectId(event.target.value)}>
            <option value="">All projects</option>
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </Select>
        </Field>
        <p className="text-sm text-muted-foreground">
          {scoped.filter((order) => order.status === 'blocked').length} blocked runs ·{' '}
          {
            findings.filter((finding) => finding.severity === 'critical' || finding.severity === 'high')
              .length
          }{' '}
          high or critical findings
        </p>
      </div>
      <Notice tone="neutral" title="Monitoring proposes; you decide.">
        <p>Recommendations do not start patches automatically. Request work after reviewing its impact.</p>
      </Notice>
      {error ? (
        <ErrorNotice>{error}</ErrorNotice>
      ) : loading && !findings.length ? (
        <LoadingState label="Loading security pipeline…" />
      ) : findings.length ? (
        <Findings findings={findings} />
      ) : (
        <EmptyState title="No recorded findings">
          Results appear after verification. An absence of findings does not replace a complete review.
        </EmptyState>
      )}
    </div>
  );
}
