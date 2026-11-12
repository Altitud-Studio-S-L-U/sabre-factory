import type { WorkOrder } from './api';
import JsonView from './components/JsonView';
import './RunReport.css';

type ReportRun = Pick<
  WorkOrder,
  | 'mode'
  | 'summary'
  | 'updated_at'
  | 'error_code'
  | 'evidence'
  | 'findings'
  | 'security_snapshot_digest'
  | 'security_rules_version'
>;

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
  return (
    <div className="run-report" aria-label="Review and security report">
      <header>
        <div>
          <h2>Review & security</h2>
          <p>Recorded results for this run. Missing evidence is never a pass.</p>
        </div>
        <time dateTime={work.updated_at}>Updated {new Date(work.updated_at).toLocaleString()}</time>
      </header>
      <div className="report-overview">
        <div>
          <span>Independent review</span>
          <strong>{evidence?.review ? 'Recorded' : 'No result recorded'}</strong>
        </div>
        <div>
          <span>Delivery checks</span>
          <strong>
            {evidence
              ? `${passed} / ${evidence.gates.length} passed on delivery snapshot`
              : 'No delivery evidence'}
          </strong>
        </div>
        <div>
          <span>Security findings</span>
          <strong>{findings.length} recorded</strong>
        </div>
      </div>
      <section aria-label="Run report">
        <h3>Run report</h3>
        <p className="report-prose">{work.summary}</p>
        {work.error_code && (
          <p className="notice warning">
            Progress is blocked: <code>{work.error_code}</code>. This summary is not a completed report.
          </p>
        )}
        {work.mode === 'audit' && !evidence && (
          <p className="muted">
            Read-only audit: a draft PR is not expected. Consult the process inspector for recorded analysis
            and checks; no final delivery report is available yet.
          </p>
        )}
      </section>
      <section aria-label="Independent review">
        <h3>Independent review</h3>
        <p className="report-prose">
          {evidence?.review ||
            'No independent review result is attached to delivery evidence yet. An agent invocation alone does not establish approval.'}
        </p>
      </section>
      <section aria-label="Verification results">
        <h3>Verification results</h3>
        {!evidence?.gates.length ? (
          <p className="muted">
            No delivery checks recorded yet. Inspect Process → Evals for intermediate results.
          </p>
        ) : (
          <ul className="report-checks">
            {evidence.gates.map((gate, index) => {
              const matches =
                Boolean(gate.snapshot_digest) && gate.snapshot_digest === evidence.snapshot_digest;
              return (
                <li key={index}>
                  <code>{gate.command.join(' ')}</code>
                  <strong className={matches && gate.exit_code === 0 ? 'report-pass' : 'report-warning'}>
                    {!matches
                      ? 'Snapshot mismatch'
                      : gate.exit_code === 0
                        ? 'Passed'
                        : `Failed · exit ${gate.exit_code}`}
                  </strong>
                  <small>Output: {gate.output_digest}</small>
                </li>
              );
            })}
          </ul>
        )}
      </section>
      <section aria-label="Security results">
        <h3>Security results</h3>
        <p className="muted">
          {work.security_snapshot_digest
            ? `Recorded scan snapshot · ${work.security_snapshot_digest}`
            : 'No scan snapshot recorded. Zero findings does not establish a completed security check.'}
        </p>
        {work.security_rules_version && <p className="muted">Rules: {work.security_rules_version}</p>}
        {findings.length > 0 && (
          <ul className="report-findings">
            {findings.map((finding) => (
              <li key={finding.fingerprint}>
                <header>
                  <strong>{finding.title}</strong>
                  <span>
                    {finding.severity} · {finding.category}
                  </span>
                </header>
                <p>
                  {finding.scanner}
                  {finding.path ? ` · ${finding.path}${finding.line ? `:${finding.line}` : ''}` : ''}
                </p>
                {finding.remediation && <p>{finding.remediation}</p>}
                {finding.exception_id && (
                  <p className="report-warning">
                    Exception recorded: {finding.exception_id}. This finding remains part of the evidence.
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
      {evidence && (
        <section>
          <h3>Evidence references</h3>
          <JsonView value={evidence} label="Delivery evidence JSON" />
        </section>
      )}
    </div>
  );
}
