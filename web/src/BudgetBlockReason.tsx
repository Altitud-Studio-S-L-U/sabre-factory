import type { BudgetView } from './api';

export default function BudgetBlockReason({
  denial,
  closed = false,
}: {
  denial: NonNullable<BudgetView['denial']>;
  /** The run has closed: the denial is retained history, not the current stop reason. */
  closed?: boolean;
}) {
  const names: Record<string, string> = {
    tokens: 'Tokens',
    invocations: 'Model calls',
    active_seconds: 'Active seconds',
    repairs: 'Repair cycles',
    api_spend: 'Run API spend · USD',
    factory_spend: 'Factory API spend · USD',
  };
  const closedNote = closed ? ' Recorded before the run closed; no budget decision is pending.' : '';
  if (denial.basis === 'historical_unknown')
    return (
      <section className="budget-denial" aria-label="Recorded budget block">
        <h3>Historical budget check</h3>
        <p>
          This older block did not record its metric or next-call reservation. Its exact cause cannot be
          recovered from the saved error. Usage below a ceiling does not prove the next call fits; these
          counters do not show a consumed limit.{closedNote}
        </p>
      </section>
    );
  const heading =
    denial.basis === 'next_reservation'
      ? closed
        ? 'Next step did not fit'
        : 'Next step does not fit'
      : 'Allowance already consumed or reserved';
  return (
    <section className="budget-denial" aria-label="Recorded budget block">
      <h3>
        {names[denial.metric] ?? 'Budget check'} · {heading}
      </h3>
      <p>
        {denial.basis === 'next_reservation'
          ? 'The next step was prevented before dispatch. Its requested reservation is not consumed usage.'
          : 'Existing usage and reservations already reached the allowance when this step was checked.'}{' '}
        Values below are the saved blocking snapshot.{closedNote}
      </p>
      <dl>
        {(
          [
            ['Measured', denial.used],
            ['Already reserved', denial.reserved],
            ['Next step request', denial.requested],
            ['Required total', denial.required],
            ['Authorized ceiling', denial.limit],
          ] as const
        ).map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>
              {value === null ? 'Not recorded' : value.toLocaleString('en-US', { maximumFractionDigits: 6 })}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
