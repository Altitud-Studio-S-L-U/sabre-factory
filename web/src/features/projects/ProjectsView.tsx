import { useEffect, useState, type FormEvent } from 'react';
import { GitBranch } from 'lucide-react';
import type { Api, Project, WorkOrder } from '../../api';
import Button from '../../components/Button';
import Input from '../../components/Input';
import Textarea from '../../components/Textarea';
import Field from '../../components/FormField';
import Select from '../../components/Select';
import Dialog from '../../components/Dialog';
import Disclosure from '../../components/Disclosure';
import CheckField from '../../components/CheckField';
import EmptyState from '../../components/EmptyState';
import PageHeader from '../../components/PageHeader';
import { Card } from '../../components/ui/card';
import { ErrorNotice, lines, requestDialogClose, useAction } from '../runs/shared';

/** Registered repositories with their checks; registration happens in a dialog. */
export default function ProjectsView({
  api,
  projects,
  orders,
  connected,
  open,
  onOpenChange,
  draftState,
  onDraftState,
  onRegistered,
  onCreateRun,
}: {
  api: Api;
  projects: Project[];
  orders: WorkOrder[];
  connected: boolean;
  open: boolean;
  onOpenChange: (open: boolean, trigger?: HTMLElement) => void;
  draftState: { busy: boolean; dirty: boolean };
  onDraftState: (state: { busy: boolean; dirty: boolean }) => void;
  onRegistered: () => Promise<void>;
  onCreateRun: (project: Project) => void;
}) {
  return (
    <div className="grid gap-6">
      <PageHeader
        eyebrow="Organization"
        title="Projects"
        description="Repositories, conventions and checks registered with the factory."
        actions={
          <Button
            variant="primary"
            type="button"
            onClick={(event) => onOpenChange(!open, event.currentTarget)}
          >
            + Register project
          </Button>
        }
      />
      <Dialog
        open={open}
        onClose={() => onOpenChange(false)}
        title="Register project"
        busy={draftState.busy}
        dirty={draftState.dirty}
        description="Register a repository and the exact checks future deliveries must pass."
      >
        {open && (
          <CreateProject
            connected={connected}
            onState={onDraftState}
            api={api}
            onDone={async () => {
              onOpenChange(false);
              await onRegistered();
            }}
            onCancel={() => onOpenChange(false)}
          />
        )}
      </Dialog>
      {projects.length === 0 ? (
        <EmptyState title="Your first project starts here">
          Register a repository and the checks its deliveries must pass.
        </EmptyState>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {projects.map((project) => (
            <Card key={project.id} className="gap-3">
              <div className="flex items-center gap-3">
                <span
                  className="grid size-10 shrink-0 place-items-center rounded-md bg-accent text-sm font-semibold text-primary"
                  aria-hidden="true"
                >
                  {project.name.slice(0, 2).toUpperCase()}
                </span>
                <div className="grid min-w-0">
                  <h2 className="truncate text-base font-semibold">{project.name}</h2>
                  <p className="truncate text-xs text-muted-foreground">{project.repository}</p>
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
                <span>{project.profile === 'python' ? 'Python' : 'JavaScript / TypeScript'}</span>
                <span className="inline-flex items-center gap-1 font-mono">
                  <GitBranch className="size-3.5" aria-hidden="true" />
                  {project.default_branch}
                </span>
                <span>
                  {project.gate_commands.length}{' '}
                  {project.gate_commands.length === 1 ? 'configured check' : 'configured checks'}
                </span>
                <span>{orders.filter((order) => order.project_id === project.id).length} runs</span>
              </div>
              <Button type="button" className="justify-self-start" onClick={() => onCreateRun(project)}>
                Create run <span aria-hidden="true">→</span>
              </Button>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

function CreateProject({
  api,
  connected,
  onState,
  onDone,
  onCancel,
}: {
  api: Api;
  connected: boolean;
  onState: (state: { busy: boolean; dirty: boolean }) => void;
  onDone: () => Promise<void>;
  onCancel: () => void;
}) {
  const action = useAction();
  const [dirty, setDirty] = useState(false);
  useEffect(() => onState({ busy: action.busy, dirty }), [onState, action.busy, dirty]);
  const [profile, setProfile] = useState<'python' | 'node'>('python');
  const [previewEnabled, setPreviewEnabled] = useState(false);
  const [commands, setCommands] = useState('["python", "-m", "pytest"]');
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!connected) return;
    const data = new FormData(event.currentTarget);
    void action.run(async () => {
      let gateCommands: string[][];
      try {
        gateCommands = lines(data.get('commands')).map((line) => {
          const command: unknown = JSON.parse(line);
          if (
            !Array.isArray(command) ||
            !command.length ||
            command.some((arg) => typeof arg !== 'string' || !arg)
          )
            throw new Error();
          return command as string[];
        });
      } catch {
        throw new Error('Each check must be a JSON argument array, for example ["python", "-m", "pytest"].');
      }
      let previewCommand: string[] = [];
      if (previewEnabled) {
        try {
          const parsed: unknown = JSON.parse(String(data.get('previewCommand')));
          if (
            !Array.isArray(parsed) ||
            !parsed.length ||
            parsed.some((item) => typeof item !== 'string' || !item)
          )
            throw new Error();
          previewCommand = parsed;
        } catch {
          throw new Error('Preview command must be a nonempty JSON argument array.');
        }
        if (data.get('synthetic') !== 'on')
          throw new Error('Browser previews require explicit synthetic-data confirmation.');
      }
      await api.createProject({
        name: String(data.get('name')),
        repository: String(data.get('repository')),
        profile,
        default_branch: String(data.get('branch')),
        gate_commands: gateCommands,
        allowed_mcp_servers: lines(data.get('mcp')),
        approved_baseline: lines(data.get('baseline')),
        browser_preview: previewEnabled
          ? {
              version: 1,
              command: previewCommand,
              port: Number(data.get('previewPort')),
              synthetic_data: true,
            }
          : null,
      });
      await onDone();
    });
  };
  return (
    <form onSubmit={submit} onChange={() => setDirty(true)} className="grid gap-5">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Project name">
          <Input name="name" maxLength={100} required placeholder="My project" />
        </Field>
        <Field label="Repository">
          <Input name="repository" required placeholder="https://github.com/example/project" />
        </Field>
        <Field label="Ecosystem">
          <Select
            value={profile}
            onChange={(event) => {
              const next = event.target.value as 'python' | 'node';
              setProfile(next);
              setCommands(next === 'python' ? '["python", "-m", "pytest"]' : '["npm", "test"]');
            }}
          >
            <option value="python">Python</option>
            <option value="node">JavaScript / TypeScript</option>
          </Select>
        </Field>
        <Field label="Base branch">
          <Input name="branch" required defaultValue="main" />
        </Field>
      </div>
      <Field
        label="Delivery checks"
        hint="One JSON argument array per line. Use the actual repository verification commands."
      >
        <Textarea
          name="commands"
          required
          rows={3}
          value={commands}
          onChange={(event) => setCommands(event.target.value)}
          className="font-mono text-xs"
        />
      </Field>
      <fieldset className="grid gap-3 rounded-lg border border-border p-4">
        <legend className="px-1 text-sm font-medium">Browser QA preview</legend>
        <CheckField
          checked={previewEnabled}
          onChange={(event) => setPreviewEnabled(event.target.checked)}
          label="Authorize a sandboxed project preview"
          hint="Only this registered command and port can be used. Evidence remains tied to the tested source snapshot."
        />
        {previewEnabled && (
          <>
            <Field label="Preview command · JSON argv">
              <Input
                name="previewCommand"
                required
                placeholder='["npm", "run", "dev", "--", "--host", "0.0.0.0"]'
              />
            </Field>
            <Field label="Preview port">
              <Input name="previewPort" type="number" min={1024} max={65535} required defaultValue={5173} />
            </Field>
            <CheckField
              name="synthetic"
              required
              label="This preview uses synthetic data and contains no production credentials."
            />
          </>
        )}
      </fieldset>
      <Disclosure summary="External tools and security baseline">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Allowed MCP servers" hint="One per line; leave empty if unnecessary.">
            <Textarea name="mcp" rows={3} />
          </Field>
          <Field
            label="Accepted existing findings"
            hint="Fingerprints you have reviewed, one per line. This cannot approve new secrets."
          >
            <Textarea name="baseline" rows={3} />
          </Field>
        </div>
      </Disclosure>
      {action.error && <ErrorNotice>{action.error}</ErrorNotice>}
      <div className="flex flex-wrap justify-end gap-2.5 border-t border-border pt-4">
        <Button
          type="button"
          variant="ghost"
          onClick={(event) => requestDialogClose(event.currentTarget, onCancel)}
          disabled={action.busy}
        >
          Cancel
        </Button>
        <Button variant="primary" disabled={action.busy || !connected}>
          {action.busy ? 'Registering…' : 'Register project'}
        </Button>
      </div>
    </form>
  );
}
