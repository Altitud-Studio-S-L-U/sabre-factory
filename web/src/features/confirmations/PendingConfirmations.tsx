import { useId, useState } from 'react';
import type { Api, OwnerConfirmation, WorkOrder } from '../../api';
import Button from '../../components/Button';
import DescriptionList, { type Description } from '../../components/DescriptionList';
import Disclosure from '../../components/Disclosure';
import Notice, { type NoticeTone } from '../../components/Notice';
import RoutedLink from '../../components/RoutedLink';
import { cn } from '../../lib/utils';
import { unresolved } from '../attention/attention';
import { runPath } from '../runs/RunsTable';
import { message } from '../runs/shared';

const kinds: Record<OwnerConfirmation['kind'], string> = {
  'budget.tokens': 'Budget',
  'budget.calls': 'Budget',
  'budget.cli_progress': 'Budget',
  'budget.amend': 'Budget',
  'budget.reconcile': 'Budget',
  'security.exception': 'Security exception',
  'question.answer': 'Owner decision',
  'repository.decide': 'Repository',
  'repository.launch': 'Repository',
};

const clock = (value: string) =>
  new Date(value).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });

function field(key: string) {
  const text = key.replaceAll('_', ' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function value(entry: unknown): string {
  if (typeof entry === 'number') return entry.toLocaleString('en-US');
  if (typeof entry === 'boolean') return entry ? 'Yes' : 'No';
  if (typeof entry === 'string') return entry;
  return entry == null ? '—' : JSON.stringify(entry);
}

/** What the decision did, in the owner's terms. A failed or unknown outcome never reads as success. */
function outcome(result: OwnerConfirmation): { tone: NoticeTone; text: string } {
  if (result.state === 'applied') return { tone: 'success', text: `Applied: ${result.summary}.` };
  if (result.state === 'rejected')
    return { tone: 'neutral', text: `Rejected: ${result.summary}. Nothing changed.` };
  if (result.state === 'failed')
    return {
      tone: 'danger',
      text: `Not applied: ${result.summary}. ${result.error_message ?? 'The operation was refused.'}${
        result.error_code ? ` (${result.error_code})` : ''
      } Check the run before asking again.`,
    };
  return {
    tone: 'warning',
    text: `The outcome of "${result.summary}" is unknown. Inspect the run before asking again.`,
  };
}

const noneDismissed: ReadonlySet<string> = new Set();

/**
 * Requests an MCP client filed for the owner. They change nothing until confirmed here, and
 * only this console can decide them; the server applies each one at most once. A decision
 * that did not take effect stays listed until the owner dismisses it.
 */
export default function PendingConfirmations({
  api,
  items,
  orders,
  connected,
  onChanged,
  dismissed = noneDismissed,
  onDismiss,
  className,
}: {
  api: Pick<Api, 'confirmRequest' | 'rejectRequest'>;
  items: OwnerConfirmation[];
  orders: Pick<WorkOrder, 'id' | 'objective'>[];
  connected: boolean;
  onChanged: () => unknown;
  /** Failed decisions the owner has already dismissed in this browser. */
  dismissed?: ReadonlySet<string>;
  onDismiss?: (id: string) => void;
  className?: string;
}) {
  const heading = useId();
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<{ id?: string; tone: NoticeTone; text: string } | null>(null);
  const pending = items.filter((item) => item.state === 'pending');
  // The decision just taken is reported by the notice below; the rest are earlier ones still unacknowledged.
  const earlier = unresolved(items, dismissed).filter((item) => item.id !== result?.id);
  if (!pending.length && !result && !earlier.length) return null;

  const decide = async (item: OwnerConfirmation, action: 'confirm' | 'reject') => {
    setBusy(item.id);
    setResult(null);
    try {
      const decided =
        action === 'confirm'
          ? await api.confirmRequest(item.id, item.request_digest)
          : await api.rejectRequest(item.id, item.request_digest);
      setResult({ id: decided.id, ...outcome(decided) });
    } catch (error) {
      setResult({ tone: 'danger', text: message(error) });
    } finally {
      setBusy(null);
      await onChanged();
    }
  };

  return (
    <section
      aria-labelledby={pending.length ? heading : undefined}
      aria-label={pending.length ? undefined : 'Decisions that did not take effect'}
      className={cn('grid gap-3', className)}
    >
      {pending.length > 0 && (
        <div className="overflow-hidden rounded-xl border border-warning-border bg-card">
          <header className="border-b border-warning-border bg-warning-bg px-4 py-3">
            <h2 id={heading} className="text-sm font-semibold text-warning">
              {pending.length === 1
                ? 'A request is waiting for your confirmation'
                : `${pending.length} requests are waiting for your confirmation`}
            </h2>
            <p className="text-sm text-muted-foreground">
              Filed over MCP by an agent acting for you. Nothing changes until you confirm it here.
            </p>
          </header>
          <ul className="divide-y divide-border">
            {pending.map((item) => {
              const order = orders.find((candidate) => candidate.id === item.work_id);
              const details: Description[] = Object.entries(item.request).map(([key, entry]) => [
                field(key),
                value(entry),
              ]);
              return (
                <li key={item.id} className="grid gap-3 px-4 py-3" data-testid="pending-confirmation">
                  <div className="flex flex-wrap items-start gap-x-4 gap-y-3">
                    <div className="grid min-w-0 flex-1 basis-72 gap-1">
                      <p className="font-medium [overflow-wrap:anywhere]">{item.summary}</p>
                      <p className="text-sm text-muted-foreground [overflow-wrap:anywhere]">
                        {kinds[item.kind]}
                        {item.work_id && (
                          <>
                            {' · '}
                            <RoutedLink
                              className="text-foreground underline underline-offset-2"
                              to={runPath(item.work_id)}
                            >
                              {order?.objective ?? `Run ${item.work_id.slice(0, 8)}`}
                            </RoutedLink>
                          </>
                        )}{' '}
                        · asked {clock(item.created_at)} · expires {clock(item.expires_at)}
                      </p>
                    </div>
                    <div className="flex shrink-0 flex-wrap gap-2">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={!connected || busy !== null}
                        aria-label={`Reject: ${item.summary}`}
                        onClick={() => void decide(item, 'reject')}
                      >
                        Reject
                      </Button>
                      <Button
                        type="button"
                        variant="primary"
                        size="sm"
                        disabled={!connected || busy !== null}
                        aria-label={`Confirm: ${item.summary}`}
                        onClick={() => void decide(item, 'confirm')}
                      >
                        {busy === item.id ? 'Working…' : 'Confirm'}
                      </Button>
                    </div>
                  </div>
                  <Disclosure variant="plain" summary="Exact request">
                    <DescriptionList items={details} termWidth="11rem" label={`Request: ${item.summary}`} />
                  </Disclosure>
                </li>
              );
            })}
          </ul>
        </div>
      )}
      {result && (
        <Notice
          tone={result.tone}
          role={result.tone === 'danger' || result.tone === 'warning' ? 'alert' : 'status'}
          actions={
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                if (result.id && (result.tone === 'danger' || result.tone === 'warning'))
                  onDismiss?.(result.id);
                setResult(null);
              }}
            >
              Dismiss
            </Button>
          }
        >
          <p>{result.text}</p>
        </Notice>
      )}
      {earlier.map((item) => {
        const report = outcome(item);
        return (
          <Notice
            key={item.id}
            tone={report.tone}
            data-testid="unresolved-confirmation"
            actions={
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-label={`Dismiss: ${item.summary}`}
                onClick={() => onDismiss?.(item.id)}
              >
                Dismiss
              </Button>
            }
          >
            <p>{report.text}</p>
            <p className="text-muted-foreground">Decided {clock(item.decided_at ?? item.created_at)}</p>
          </Notice>
        );
      })}
    </section>
  );
}
