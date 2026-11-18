import type { BudgetView } from './api';

const frame = 'grid min-w-0 gap-3 rounded-lg border border-border bg-card p-5';
const titleClass = 'text-base font-semibold';
const explanation = 'max-w-[90ch] text-xs leading-relaxed text-muted-foreground';

export default function BudgetBlockReason({
  denial,
  closed = false,
  authorizationUpdated = false,
}: {
  denial: NonNullable<BudgetView['denial']>;
  /** The run has closed: the denial is retained history, not the current stop reason. */
  closed?: boolean;
  authorizationUpdated?: boolean;
}) {
  const names: Record<string, string> = {
    tokens: 'Tokens',
    invocations: 'Model calls',
    active_seconds: 'Active seconds',
    repairs: 'Repair cycles',
    api_spend: 'Run API spend · USD',
    factory_spend: 'Factory API spend · USD',
  };
  const closedNote = closed
    ? ' Recorded before the run closed; no budget decision is pending.'
    : authorizationUpdated
      ? ' The saved authorization covers this recorded requirement. Resume will recheck current controls.'
      : '';
  if (denial.basis === 'historical_unknown')
    return (
      <section className={frame} aria-label="Recorded budget block">
        <h3 className={titleClass}>Historical budget check</h3>
        <p className={explanation}>
          This older block did not record its metric or next-call reservation. Its exact cause cannot be
          recovered from the saved error. Usage below a ceiling does not prove the next call fits; these
          counters do not show a consumed limit.{closedNote}
        </p>
      </section>
    );
  const heading =
    denial.basis === 'next_reservation'
      ? closed || authorizationUpdated
        ? 'Next step did not fit'
        : 'Next step does not fit'
      : 'Allowance already consumed or reserved';
  return (
    <section className={frame} aria-label="Recorded budget block">
      <h3 className={titleClass}>
        {names[denial.metric] ?? 'Budget check'} · {heading}
      </h3>
      <p className={explanation}>
        {denial.basis === 'next_reservation'
          ? 'The next step was prevented before dispatch. Its requested reservation is not consumed usage.'
          : 'Existing usage and reservations already reached the allowance when this step was checked.'}{' '}
        Values below are the saved blocking snapshot.{closedNote}
      </p>
      <dl className="grid [grid-template-columns:repeat(auto-fit,minmax(8.5rem,1fr))] gap-4">
        {(
          [
            ['Measured', denial.used],
            ['Already reserved', denial.reserved],
            ['Next step request', denial.requested],
            ['Required total', denial.required],
            ['Authorized ceiling', denial.limit],
          ] as const
        ).map(([label, value]) => (
          <div key={label} className="grid min-w-0 content-start gap-1">
            <dt className="text-xs text-muted-foreground">{label}</dt>
            <dd className="text-base font-medium tabular-nums [overflow-wrap:anywhere]">
              {value === null ? 'Not recorded' : value.toLocaleString('en-US', { maximumFractionDigits: 6 })}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
