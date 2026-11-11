import type { BudgetPolicy, MetricBudget } from '../api';
import Field from './FormField';
import Select from './Select';

export const defaultBudgetPolicy: BudgetPolicy = {
  version: 1,
  tokens: { primary: 100000, reserve: 0, absolute: 100000 },
  invocations: { primary: 40, reserve: 0, absolute: 40 },
  active_seconds: { primary: 3600, reserve: 0, absolute: 3600 },
  repairs: { primary: 2, reserve: 0, absolute: 2 },
  no_progress_threshold: 3,
};
const names = {
  tokens: 'Tokens',
  invocations: 'Model invocations',
  active_seconds: 'Active time · seconds',
  repairs: 'Repair cycles',
} as const;
export default function BudgetFields({
  value,
  onChange,
}: {
  value: BudgetPolicy;
  onChange: (value: BudgetPolicy) => void;
}) {
  const update = (metric: keyof typeof names, next: MetricBudget) => onChange({ ...value, [metric]: next });
  return (
    <div>
      <p className="operator-readonly">
        Each metric has an independent ceiling. A reserve is a finite authorization granted once; it never
        replenishes automatically. Paid API spend remains separately authorized.
      </p>
      {Object.entries(names).map(([id, label]) => {
        const metric = id as keyof typeof names;
        const policy = value[metric];
        const mode = policy.primary === null ? 'uncapped' : policy.reserve ? 'reserve' : 'bounded';
        return (
          <fieldset key={metric} style={{ marginTop: 18 }}>
            <legend>{label}</legend>
            <Field label={`${label} policy`}>
              <Select
                value={mode}
                onChange={(event) => {
                  const selected = event.target.value;
                  const primary = policy.primary ?? defaultBudgetPolicy[metric].primary!;
                  update(
                    metric,
                    selected === 'uncapped'
                      ? { primary: null, reserve: 0, absolute: null }
                      : selected === 'reserve'
                        ? {
                            primary,
                            reserve: policy.reserve || Math.max(1, Math.ceil(primary / 2)),
                            absolute: primary + (policy.reserve || Math.max(1, Math.ceil(primary / 2))),
                          }
                        : { primary, reserve: 0, absolute: primary },
                  );
                }}
              >
                <option value="bounded">Bounded</option>
                <option value="reserve">With finite reserve</option>
                <option value="uncapped">No cumulative cap</option>
              </Select>
            </Field>
            {policy.primary === null ? (
              <p className="notice warning">
                No run-level cumulative {label.toLowerCase()} cap. Factory and provider constraints,
                cancellation and per-operation safeguards still apply.
              </p>
            ) : (
              <div className="operator-two">
                <Field label={`${label} primary ceiling`}>
                  <input
                    type="number"
                    min={0}
                    max={1000000000}
                    value={policy.primary}
                    onChange={(event) => {
                      const primary = Number(event.target.value);
                      update(metric, { ...policy, primary, absolute: primary + policy.reserve });
                    }}
                  />
                </Field>
                {mode === 'reserve' && (
                  <Field label={`${label} authorized reserve`}>
                    <input
                      type="number"
                      min={1}
                      max={1000000000}
                      value={policy.reserve}
                      onChange={(event) => {
                        const reserve = Number(event.target.value);
                        update(metric, { ...policy, reserve, absolute: policy.primary! + reserve });
                      }}
                    />
                  </Field>
                )}
                <p className="operator-readonly">
                  Absolute authorized ceiling: {policy.absolute?.toLocaleString('en-US')}.{' '}
                  {metric === 'repairs' && policy.primary === 0
                    ? 'Zero repairs permits no repair attempts.'
                    : ''}
                </p>
              </div>
            )}
          </fieldset>
        );
      })}
      <Field
        label="Repeated no-progress threshold"
        hint="Stop repeated identical failures for operator review; this never weakens verification."
      >
        <input
          type="number"
          min={2}
          max={20}
          value={value.no_progress_threshold}
          onChange={(event) => onChange({ ...value, no_progress_threshold: Number(event.target.value) })}
        />
      </Field>
      <p className="operator-readonly">
        On exhaustion, the run checkpoints and stops new dispatch. It can resume after an authorized amendment
        or use only its remaining preauthorized reserve. CLI aggregate token usage may be known only after an
        invocation.
      </p>
    </div>
  );
}
