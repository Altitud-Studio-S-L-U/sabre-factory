import type { ReactNode } from 'react';
import type { WorkOrder } from './api';
import JsonView from './components/JsonView';
import Notice from './components/Notice';
import { currentBlocker, historicalError } from './runState';
import { cn } from './lib/utils';

type ReportRun = Pick<
  WorkOrder,
  | 'status'
  | 'mode'
  | 'summary'
  | 'updated_at'
  | 'error_code'
  | 'evidence'
  | 'findings'
  | 'security_snapshot_digest'
  | 'security_rules_version'
>;

const muted = 'text-sm text-muted-foreground';

function Part({ label, title, children }: { label?: string; title: string; children: ReactNode }) {
  return (
    <section aria-label={label} className="grid min-w-0 gap-2 border-t border-border pt-4">
      <h3 className="text-base font-semibold">{title}</h3>
      {children}
    </section>
  );
}

export default function RunReport({ work }: { work: ReportRun }) {
  const evidence = work.evidence;
  const findings = [
    ...new Map(
      [...work.findings, ...(evidence?.findings ?? [])].map((finding) => [finding.fingerprint, finding]),
    ).values(),
  ];
  const matched =
    evidence?.gates.filter(
      (gate) => Boolean(gate.snapshot_digest) && gate.snapshot_digest === evidence.snapshot_digest,
    ) ?? [];
  const passed = matched.filter((gate) => gate.exit_code === 0).length;
  const blocker = currentBlocker(work);
  const history = historicalError(work);
  return (
    <div
      aria-label="Review and security report"
      className="grid min-w-0 gap-5 rounded-xl border border-border bg-card p-5"
    >
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="grid gap-1">
          <h2 className="text-lg font-semibold">Review & security</h2>
          <p className={muted}>Recorded results for this run. Missing evidence is never a pass.</p>
        </div>
        <time className="text-xs text-muted-foreground" dateTime={work.updated_at}>
          Updated {new Date(work.updated_at).toLocaleString()}
        </time>
      </header>
      <div className="grid gap-2 sm:grid-cols-3">
        {[
          ['Independent review', evidence?.review ? 'Recorded' : 'No result recorded'],
          [
            'Delivery checks',
            evidence
              ? `${passed} / ${evidence.gates.length} passed on delivery snapshot`
              : 'No delivery evidence',
          ],
          ['Security findings', `${findings.length} recorded`],
        ].map(([label, value]) => (
          <div key={label} className="grid gap-1 rounded-lg border border-border bg-code px-4 py-3">
            <span className="text-xs text-muted-foreground">{label}</span>
            <strong className="text-sm font-semibold">{value}</strong>
          </div>
        ))}
      </div>
      <Part label="Run report" title="Run report">
        <p className="text-sm whitespace-pre-wrap">{work.summary}</p>
        {blocker && (
          <Notice tone="warning">
            <p>
              Progress is blocked: <code className="font-mono">{blocker}</code>. This summary is not a
              completed report.
            </p>
          </Notice>
        )}
        {work.status === 'cancelled' && (
          <Notice tone="neutral">
            <p>
              {history ? (
                <>
                  This run was cancelled after <code className="font-mono">{history}</code> was recorded.{' '}
                </>
              ) : (
                'This run was cancelled. '
              )}
              This summary is not a completed report.
            </p>
          </Notice>
        )}
        {work.mode === 'audit' && !evidence && (
          <p className={muted}>
            Read-only audit: a draft PR is not expected. Consult the process inspector for recorded analysis
            and checks; no final delivery report is available yet.
          </p>
        )}
      </Part>
      <Part label="Independent review" title="Independent review">
        <p className="text-sm whitespace-pre-wrap">
          {evidence?.review ||
            'No independent review result is attached to delivery evidence yet. An agent invocation alone does not establish approval.'}
        </p>
      </Part>
      <Part label="Verification results" title="Verification results">
        {!evidence?.gates.length ? (
          <p className={muted}>
            No delivery checks recorded yet. Inspect Process → Evals for intermediate results.
          </p>
        ) : (
          <ul className="grid gap-2">
            {evidence.gates.map((gate, index) => {
              const matches =
                Boolean(gate.snapshot_digest) && gate.snapshot_digest === evidence.snapshot_digest;
              const ok = matches && gate.exit_code === 0;
              return (
                <li key={index} className="grid gap-1 rounded-md border border-border bg-code px-3 py-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <code className="font-mono text-xs [overflow-wrap:anywhere]">
                      {gate.command.join(' ')}
                    </code>
                    <strong className={cn('text-sm', ok ? 'text-success' : 'text-warning')}>
                      {!matches
                        ? 'Snapshot mismatch'
                        : gate.exit_code === 0
                          ? 'Passed'
                          : `Failed · exit ${gate.exit_code}`}
                    </strong>
                  </div>
                  <small className="font-mono text-xs [overflow-wrap:anywhere] text-muted-foreground">
                    Output: {gate.output_digest}
                  </small>
                </li>
              );
            })}
          </ul>
        )}
      </Part>
      <Part label="Security results" title="Security results">
        <p className={cn(muted, '[overflow-wrap:anywhere]')}>
          {work.security_snapshot_digest
            ? `Recorded scan snapshot · ${work.security_snapshot_digest}`
            : 'No scan snapshot recorded. Zero findings does not establish a completed security check.'}
        </p>
        {work.security_rules_version && <p className={muted}>Rules: {work.security_rules_version}</p>}
        {findings.length > 0 && (
          <ul className="grid gap-2">
            {findings.map((finding) => (
              <li
                key={finding.fingerprint}
                className="grid gap-1 rounded-md border border-border bg-code px-3 py-2 text-sm"
              >
                <header className="flex flex-wrap items-baseline justify-between gap-2">
                  <strong className="font-medium">{finding.title}</strong>
                  <span className="text-xs text-muted-foreground">
                    {finding.severity} · {finding.category}
                  </span>
                </header>
                <p className="text-xs text-muted-foreground">
                  {finding.scanner}
                  {finding.path ? ` · ${finding.path}${finding.line ? `:${finding.line}` : ''}` : ''}
                </p>
                {finding.remediation && <p>{finding.remediation}</p>}
                {finding.exception_id && (
                  <p className="text-warning">
                    Exception recorded: {finding.exception_id}. This finding remains part of the evidence.
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
      </Part>
      {evidence && (
        <Part title="Evidence references">
          <JsonView value={evidence} label="Delivery evidence JSON" />
        </Part>
      )}
    </div>
  );
}
