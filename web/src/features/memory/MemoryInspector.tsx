import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import type { Api, MemoryDetail } from '../../api';
import Button from '../../components/Button';
import DescriptionList from '../../components/DescriptionList';
import LoadingState from '../../components/LoadingState';
import Notice from '../../components/Notice';
import { message } from '../runs/shared';
import { runPath } from '../runs/RunsTable';
import { KindBadge, StateBadge, proposer, relative, short, validityReasons } from './shared';

function Step({ tone, children }: { tone: string; children: React.ReactNode }) {
  return (
    <li className="grid grid-cols-[0.75rem_minmax(0,1fr)] items-start gap-2.5 text-sm">
      <span aria-hidden="true" className="mt-1.5 size-2.5 rounded-full" style={{ background: tone }} />
      <span className="min-w-0 [overflow-wrap:anywhere]">{children}</span>
    </li>
  );
}

/** One memory: what it says, where it came from, whether it still holds and who recalled it. */
export default function MemoryInspector({
  api,
  memoryId,
  connected,
  refreshKey,
  onChanged,
  onFocus,
}: {
  api: Api;
  memoryId: string;
  connected: boolean;
  refreshKey: number;
  onChanged: (notice: string) => void;
  onFocus: (memoryId: string) => void;
}) {
  const [state, setState] = useState<{ key: string; detail?: MemoryDetail; error?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState('');
  const key = `${memoryId}|${refreshKey}`;
  useEffect(() => {
    let live = true;
    void api
      .memoryDetail(memoryId)
      .then((detail) => {
        if (!live) return;
        if (!detail?.item || !detail.provenance)
          setState({ key, error: 'The server returned an unexpected memory record.' });
        else setState({ key, detail });
      })
      .catch((error: unknown) => live && setState({ key, error: message(error) }));
    return () => {
      live = false;
    };
  }, [api, memoryId, key]);
  const current = state?.key === key ? state : null;
  const detail = current?.detail;
  const act = async (run: () => Promise<unknown>, notice: string) => {
    if (busy || !connected) return;
    setBusy(true);
    setActionError('');
    try {
      await run();
      onChanged(notice);
    } catch (error) {
      setActionError(message(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <aside
      aria-label="Memory inspector"
      className="grid min-w-0 content-start gap-4 rounded-xl border border-border bg-card p-4"
    >
      {current?.error && (
        <Notice tone="danger" role="alert">
          {current.error}
        </Notice>
      )}
      {!current && <LoadingState label="Loading memory…" />}
      {detail && (
        <>
          <div className="grid gap-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="flex gap-1.5">
                <KindBadge kind={detail.item.kind} />
                <StateBadge state={detail.item.state} />
              </span>
              <code className="font-mono text-xs text-muted-foreground">{short(detail.item.id)}</code>
            </div>
            <p className="rounded-lg border border-border bg-code p-3 text-sm leading-relaxed whitespace-pre-wrap">
              {detail.item.content}
            </p>
          </div>
          <div className="grid gap-2">
            <h3 className="text-xs font-medium text-muted-foreground">Provenance</h3>
            <ol className="grid gap-2">
              <Step tone="var(--success)">Proposed by {proposer(detail.provenance.proposed_by)}</Step>
              <Step tone="var(--info)">
                From run{' '}
                <Link to={runPath(detail.provenance.work_id)} className="hover:underline">
                  {detail.provenance.work_objective ?? short(detail.provenance.work_id)}
                </Link>
                {detail.provenance.work_status
                  ? ` · ${detail.provenance.work_status.replaceAll('_', ' ')}`
                  : ''}
              </Step>
              <Step tone="var(--color-muted-foreground)">
                At commit <code className="font-mono text-xs">{detail.provenance.commit.slice(0, 12)}</code>
                {detail.provenance.evidence_digest ? ' · evidence digest retained' : ' · no evidence digest'}
              </Step>
              <Step tone="var(--primary)">
                {detail.provenance.invalidated_at
                  ? `Invalidated ${new Date(detail.provenance.invalidated_at).toLocaleString('en-US')}`
                  : detail.provenance.approved_at
                    ? `Approved ${new Date(detail.provenance.approved_at).toLocaleString('en-US')}`
                    : 'Waiting for your review'}
              </Step>
            </ol>
          </div>
          <DescriptionList
            termWidth="6.5rem"
            stackBelow="never"
            items={[
              [
                'Recalled',
                detail.recalls.recall_count
                  ? `${detail.recalls.recall_count} times · last ${relative(detail.recalls.last_recalled_at)}`
                  : 'Never recalled yet',
              ],
              detail.recalls.refused_count > 0 && [
                'Refused',
                `${detail.recalls.refused_count} calls stopped because it had changed`,
              ],
              [
                'Holds',
                <span
                  key="validity"
                  className={detail.item.validity.state === 'stale' ? 'text-warning' : undefined}
                >
                  {validityReasons[detail.item.validity.reason] ?? detail.item.validity.reason}
                  {detail.item.validity.commit ? ` · at ${detail.item.validity.commit.slice(0, 8)}` : ''}
                </span>,
              ],
              [
                'Scope',
                detail.item.scope === 'project' ? 'Project · carried across commits' : 'This commit only',
              ],
              detail.item.citations.length > 0 && [
                'Cites',
                <span key="cites" className="flex flex-wrap gap-1">
                  {detail.item.citations.map((path) => (
                    <code key={path} className="rounded bg-secondary px-1.5 py-0.5 text-xs">
                      {path}
                    </code>
                  ))}
                </span>,
              ],
            ]}
          />
          {detail.item.validity.changed_paths.length > 0 && (
            <Notice tone="warning" title="Cited files changed">
              <ul className="grid gap-0.5 text-xs">
                {detail.item.validity.changed_paths.map((change) => (
                  <li key={change.path}>
                    <code>{change.path}</code> · {change.change}
                  </li>
                ))}
              </ul>
            </Notice>
          )}
          {[...detail.links, ...detail.backlinks].some((link) => link.target_type === 'memory') && (
            <div className="grid gap-1.5">
              <h3 className="text-xs font-medium text-muted-foreground">Linked memories</h3>
              <ul className="grid gap-1">
                {[...detail.links, ...detail.backlinks]
                  .filter((link) => link.target_type === 'memory')
                  .map((link) => {
                    const other = link.source_id === detail.item.id ? link.target_id : link.source_id;
                    const outgoing = link.source_id === detail.item.id;
                    return (
                      <li key={`${link.source_id}-${link.kind}-${link.target_id}`}>
                        <button
                          type="button"
                          onClick={() => onFocus(other)}
                          className="flex w-full cursor-pointer items-center justify-between gap-2 rounded-md bg-secondary/60 px-2.5 py-1.5 text-left text-xs hover:bg-hover"
                        >
                          <span>
                            {outgoing ? link.kind : `${link.kind} by`}{' '}
                            <code className="font-mono">{short(other)}</code>
                          </span>
                          <span aria-hidden="true">→</span>
                        </button>
                      </li>
                    );
                  })}
              </ul>
            </div>
          )}
          {actionError && (
            <Notice tone="danger" role="alert">
              {actionError}
            </Notice>
          )}
          <div className="flex flex-wrap gap-2">
            {detail.item.state === 'pending' && (
              <Button
                variant="primary"
                size="sm"
                disabled={busy || !connected}
                onClick={() =>
                  void act(
                    () => api.approveMemory(detail.item.id, {}),
                    'Memory approved with its recorded provenance.',
                  )
                }
              >
                Approve
              </Button>
            )}
            {detail.item.validity.state === 'stale' && detail.item.validity.commit && (
              <Button
                size="sm"
                disabled={busy || !connected}
                onClick={() =>
                  void act(
                    () => api.carryMemoryForward(detail.item.id, detail.item.validity.commit!),
                    'Memory carried forward to the current commit on your authority.',
                  )
                }
              >
                Carry forward
              </Button>
            )}
            {detail.item.state !== 'invalidated' && (
              <Button
                variant="danger"
                size="sm"
                disabled={busy || !connected}
                onClick={() =>
                  void act(
                    () => api.memoryAction(detail.item.id, 'invalidate'),
                    'Memory invalidated. It will no longer guide new context retrieval.',
                  )
                }
              >
                Invalidate
              </Button>
            )}
          </div>
        </>
      )}
    </aside>
  );
}
