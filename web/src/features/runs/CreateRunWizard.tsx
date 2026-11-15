import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Check } from 'lucide-react';
import type { Api, FlowConfiguration as FlowConfig, Project, WorkOrder } from '../../api';
import Button from '../../components/Button';
import Input from '../../components/Input';
import Textarea from '../../components/Textarea';
import Field from '../../components/FormField';
import Select from '../../components/Select';
import EmptyState from '../../components/EmptyState';
import DescriptionList from '../../components/DescriptionList';
import BudgetFields, { defaultBudgetPolicy } from '../../components/BudgetFields';
import FlowConfiguration from '../../FlowConfiguration';
import { cn } from '../../lib/utils';
import { ErrorNotice, lines, modeDescriptions, modeLabels, requestDialogClose, useAction } from './shared';

type Mode = WorkOrder['mode'];
const modes: Mode[] = ['create', 'maintain', 'patch', 'audit'];
const steps = ['Work', 'Acceptance', 'Flow & limits', 'Review'] as const;

/** Controls that take part in validation inside one step. */
function controls(step: HTMLElement | null) {
  return Array.from(
    step?.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(
      'input,textarea,select',
    ) ?? [],
  );
}

/**
 * New run as four short steps. Every step stays mounted so drafts survive moving back and
 * forth; Next validates the visible step and Launch validates all of them, opening the first
 * step that needs attention. Nothing is sent before Launch.
 */
export default function CreateRunWizard({
  api,
  connected,
  onState,
  projects,
  initialProjectId,
  onDone,
  onCancel,
  onCreateProject,
}: {
  api: Api;
  connected: boolean;
  onState: (state: { busy: boolean; dirty: boolean }) => void;
  projects: Project[];
  initialProjectId: string;
  onDone: (order: WorkOrder) => Promise<void>;
  onCancel: () => void;
  onCreateProject: () => void;
}) {
  const action = useAction();
  const [dirty, setDirty] = useState(false);
  useEffect(() => onState({ busy: action.busy, dirty }), [onState, action.busy, dirty]);
  const [mode, setMode] = useState<Mode>('patch');
  const [step, setStep] = useState(0);
  const [defaults, setDefaults] = useState<Partial<Record<Mode, FlowConfig>>>({});
  const [flowDrafts, setFlowDrafts] = useState<typeof defaults>({});
  const [configurationError, setConfigurationError] = useState('');
  const [summary, setSummary] = useState({
    project: '',
    objective: '',
    acceptance: [] as string[],
    constraints: [] as string[],
    cost: '0',
  });
  const stepRefs = useRef<(HTMLElement | null)[]>([]);
  const formRef = useRef<HTMLFormElement>(null);
  const invalid = useRef<HTMLElement | null>(null);
  useEffect(() => {
    let current = true;
    void api
      .configuration()
      .then((view) => {
        if (current) setDefaults(view.configuration.flows);
      })
      .catch(() => {
        if (current)
          setConfigurationError('Factory defaults could not be loaded. Reopen this dialog to retry.');
      });
    return () => {
      current = false;
    };
  }, [api]);
  // Report a control that failed validation once its step is visible.
  useEffect(() => {
    const control = invalid.current;
    if (!control) return;
    invalid.current = null;
    (control as HTMLInputElement).reportValidity?.();
    control.focus();
  }, [step]);
  const flowConfig = flowDrafts[mode] ?? defaults[mode] ?? { version: 1, repair_cycles: 2 };
  const setFlowConfig = (next: FlowConfig) => {
    setDirty(true);
    setFlowDrafts((previous) => ({ ...previous, [mode]: next }));
  };
  const [key] = useState(() => crypto.randomUUID());
  if (!projects.length)
    return (
      <EmptyState
        title="Add a project to get started"
        actions={
          <Button type="button" variant="primary" onClick={onCreateProject}>
            Add project
          </Button>
        }
      >
        A run works on a project: a repository SABRE is authorized to work on, with the checks its deliveries
        must pass.
      </EmptyState>
    );

  const readSummary = () => {
    const data = new FormData(formRef.current!);
    setSummary({
      project: projects.find((project) => project.id === data.get('project'))?.name ?? '',
      objective: String(data.get('objective') ?? ''),
      acceptance: lines(data.get('acceptance')),
      constraints: lines(data.get('constraints')),
      cost: String(data.get('cost') ?? '0'),
    });
  };
  const go = (next: number) => {
    readSummary();
    setStep(next);
  };
  /** First step (up to `last`) holding an invalid control, or -1. */
  const firstInvalid = (last: number) => {
    for (let index = 0; index <= last; index += 1) {
      const bad = controls(stepRefs.current[index]).find((control) => !control.checkValidity());
      if (bad) return { index, control: bad };
    }
    return null;
  };
  const advance = () => {
    const bad = controls(stepRefs.current[step]).find((control) => !control.checkValidity());
    if (bad) {
      bad.reportValidity();
      bad.focus();
      return;
    }
    go(step + 1);
  };
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const submitter = (event.nativeEvent as SubmitEvent).submitter;
    if (submitter && submitter.getAttribute('type') !== 'submit') return;
    if (step < steps.length - 1) {
      advance();
      return;
    }
    if (!connected) return;
    const bad = firstInvalid(steps.length - 1);
    if (bad) {
      invalid.current = bad.control;
      if (bad.index === step) {
        bad.control.reportValidity();
        bad.control.focus();
      } else setStep(bad.index);
      return;
    }
    const data = new FormData(event.currentTarget);
    void action.run(async () => {
      const order = await api.createWork({
        project_id: String(data.get('project')),
        mode,
        flow_config: flowConfig,
        objective: String(data.get('objective')),
        acceptance: lines(data.get('acceptance')),
        constraints: lines(data.get('constraints')),
        budget: {
          max_cost_usd: Number(data.get('cost')),
          max_calls: null,
          max_tokens: null,
          active_seconds: null,
          policy: flowConfig.budget_policy ?? defaultBudgetPolicy,
        },
        idempotency_key: key,
        channel: 'web',
        channel_thread: null,
      });
      await onDone(order);
    });
  };
  const last = step === steps.length - 1;
  return (
    <form ref={formRef} noValidate onSubmit={submit} onChange={() => setDirty(true)} className="grid gap-6">
      <nav aria-label="New run steps">
        <ol className="grid grid-cols-4 gap-2">
          {steps.map((label, index) => {
            const done = index < step;
            const current = index === step;
            return (
              <li key={label} className="min-w-0">
                <button
                  type="button"
                  aria-current={current ? 'step' : undefined}
                  disabled={action.busy}
                  onClick={() => go(index)}
                  className={cn(
                    'group grid w-full min-w-0 cursor-pointer gap-1.5 text-left disabled:cursor-not-allowed disabled:opacity-50',
                  )}
                >
                  <span
                    className={cn(
                      'h-1 rounded-full bg-border transition-colors',
                      (done || current) && 'bg-primary',
                    )}
                    aria-hidden="true"
                  />
                  <span
                    className={cn(
                      'flex min-w-0 items-center gap-1.5 text-xs font-medium text-muted-foreground',
                      current && 'text-foreground',
                    )}
                  >
                    {done && <Check className="size-3.5 shrink-0 text-primary" aria-hidden="true" />}
                    <span className="truncate">
                      <span className="sr-only">Step {index + 1}: </span>
                      {label}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
      </nav>

      <section
        ref={(element) => {
          stepRefs.current[0] = element;
        }}
        hidden={step !== 0}
        aria-label="Work"
        className="grid gap-5"
      >
        <fieldset className="grid gap-2">
          <legend className="mb-2 text-sm font-medium">Work type</legend>
          <div className="grid gap-2 sm:grid-cols-2">
            {modes.map((item) => (
              <label
                key={item}
                className={cn(
                  'flex cursor-pointer items-start gap-3 rounded-lg border border-border bg-card p-3.5 transition-colors hover:bg-hover/50',
                  mode === item && 'border-primary bg-accent',
                )}
              >
                <Input
                  type="radio"
                  name="mode"
                  value={item}
                  checked={mode === item}
                  onChange={() => setMode(item)}
                  className="mt-0.5"
                />
                <span className="grid gap-0.5">
                  <strong className="text-sm font-semibold">{modeLabels[item]}</strong>
                  <span className="text-xs text-muted-foreground">{modeDescriptions[item]}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>
        <Field label="Project">
          <Select name="project" defaultValue={initialProjectId || projects[0].id} required>
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="What do you need?" hint="Describe the outcome and the context the team needs.">
          <Textarea
            name="objective"
            required
            minLength={5}
            maxLength={12000}
            rows={4}
            placeholder="I need…"
          />
        </Field>
      </section>

      <section
        ref={(element) => {
          stepRefs.current[1] = element;
        }}
        hidden={step !== 1}
        aria-label="Acceptance"
        className="grid gap-5 sm:grid-cols-2"
      >
        <Field label="Acceptance criteria" hint="One verifiable outcome per line.">
          <Textarea
            name="acceptance"
            required
            rows={6}
            placeholder="After completion, it must be possible to…"
          />
        </Field>
        <Field label="Constraints" hint="One per line, if needed.">
          <Textarea name="constraints" rows={6} placeholder="Compatibility, scope, conventions…" />
        </Field>
      </section>

      <section
        ref={(element) => {
          stepRefs.current[2] = element;
        }}
        hidden={step !== 2}
        aria-label="Flow & limits"
        className="grid gap-5"
      >
        {configurationError && <ErrorNotice>{configurationError}</ErrorNotice>}
        {!defaults[mode] && !configurationError && (
          <p role="status" className="text-sm text-muted-foreground">
            Loading configured flow defaults…
          </p>
        )}
        <FlowConfiguration api={api} mode={mode} value={flowConfig} onChange={setFlowConfig} />
        <fieldset className="grid gap-4 rounded-lg border border-border p-4">
          <legend className="px-1 text-sm font-medium">Run budget policy</legend>
          <Field
            label="Maximum paid API spend · USD"
            hint="CLI subscription usage is recorded separately. Zero does not authorize paid API calls."
          >
            <Input name="cost" type="number" min="0" max="1000" step="0.01" required defaultValue="0" />
          </Field>
          <BudgetFields
            value={{ ...defaultBudgetPolicy, ...flowConfig.budget_policy }}
            onChange={(budget_policy) => setFlowConfig({ ...flowConfig, budget_policy })}
          />
          <p className="text-xs text-muted-foreground">
            Reaching a ceiling pauses progress for an owner decision. Increasing a limit never resumes a run
            automatically.
          </p>
        </fieldset>
      </section>

      <section hidden={step !== 3} aria-label="Review" className="grid gap-4">
        <p className="text-sm text-muted-foreground">
          Check the run before launching. Nothing has been sent yet.
        </p>
        <DescriptionList
          className="rounded-lg border border-border bg-card p-4"
          items={[
            ['Work type', `${modeLabels[mode]} · ${modeDescriptions[mode]}`],
            ['Project', summary.project],
            ['Objective', <span className="whitespace-pre-wrap">{summary.objective}</span>],
            [
              'Acceptance',
              <ul className="grid list-disc gap-1 pl-4">
                {summary.acceptance.map((item, index) => (
                  <li key={index}>{item}</li>
                ))}
              </ul>,
            ],
            summary.constraints.length > 0 && [
              'Constraints',
              <ul className="grid list-disc gap-1 pl-4">
                {summary.constraints.map((item, index) => (
                  <li key={index}>{item}</li>
                ))}
              </ul>,
            ],
            ['Repair cycles', String(flowConfig.repair_cycles ?? 2)],
            ['Paid API spend', `USD ${Number(summary.cost || 0).toFixed(2)}`],
          ]}
        />
      </section>

      {action.error && <ErrorNotice>{action.error}</ErrorNotice>}
      <div className="flex flex-wrap items-center justify-end gap-2.5 border-t border-border pt-4">
        <Button
          type="button"
          className="mr-auto"
          variant="ghost"
          onClick={(event) => requestDialogClose(event.currentTarget, onCancel)}
          disabled={action.busy}
        >
          Cancel
        </Button>
        {step > 0 && (
          <Button type="button" disabled={action.busy} onClick={() => go(step - 1)}>
            Back
          </Button>
        )}
        {/* Distinct keys: reusing one element would turn the clicked Next into a submit button
            before the click's default action runs, launching the run from the Flow step. */}
        {last ? (
          <Button
            key="launch"
            type="submit"
            variant="primary"
            disabled={action.busy || !connected || !defaults[mode] || Boolean(configurationError)}
          >
            {action.busy ? 'Sending…' : 'Launch flow'}
          </Button>
        ) : (
          <Button key="next" type="button" variant="primary" disabled={action.busy} onClick={advance}>
            Next
          </Button>
        )}
      </div>
    </form>
  );
}
