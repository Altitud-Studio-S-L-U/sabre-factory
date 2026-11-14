import { useEffect, useRef, useState, type FormEvent } from 'react';
import { GitBranch } from 'lucide-react';
import type { Api, Project, WorkOrder } from '../../api';
import Button from '../../components/Button';
import Input from '../../components/Input';
import Textarea from '../../components/Textarea';
import Field from '../../components/FormField';
import Select from '../../components/Select';
import Dialog, { DialogActions } from '../../components/Dialog';
import Disclosure from '../../components/Disclosure';
import CheckField from '../../components/CheckField';
import EmptyState from '../../components/EmptyState';
import PageHeader from '../../components/PageHeader';
import SegmentedControl from '../../components/SegmentedControl';
import RepoCreations from '../../RepoCreations';
import GitHubRepositories from '../tools/GitHubRepositories';
import { Badge } from '../../components/ui/badge';
import { Card } from '../../components/ui/card';
import { ErrorNotice, lines, requestDialogClose, useAction } from '../runs/shared';

/** One JSON argument array, as the runner executes it. */
function argv(value: string, error: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed) || !parsed.length || parsed.some((arg) => typeof arg !== 'string' || !arg))
      throw new Error();
    return parsed as string[];
  } catch {
    throw new Error(error);
  }
}

/** Where a new project comes from. Every source ends in a registered repository with its checks. */
const SOURCES = [
  { value: 'github', label: 'From GitHub' },
  { value: 'address', label: 'By address' },
  { value: 'new', label: 'New repository' },
] as const;
type Source = (typeof SOURCES)[number]['value'];

/**
 * Registered repositories with their checks. A project is added, edited and archived here;
 * `projects` carries the archived ones too, shown only on request.
 */
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
  const [showArchived, setShowArchived] = useState(false);
  // By address until the factory says GitHub can be browsed; the owner's own choice is never overridden.
  const [source, setSource] = useState<Source>('address');
  const chosen = useRef(false);
  const [github, setGithub] = useState<{ enabled: boolean; installed: boolean } | null>(null);
  useEffect(() => {
    if (!open) return;
    let current = true;
    Promise.all([api.integrations(), api.githubConnection()]).then(
      ([integrations, connection]) => {
        if (!current) return;
        const installed = connection?.state === 'connected';
        setGithub({
          enabled: integrations.find((item) => item.id === 'github.read')?.enabled ?? false,
          installed,
        });
        // With the app installed its repositories are one click away: start there.
        if (installed && !chosen.current) setSource('github');
      },
      // GitHub cannot be described: the address form still works.
      () => current && setGithub({ enabled: false, installed: false }),
    );
    return () => {
      current = false;
    };
  }, [api, open]);
  const [editingId, setEditingId] = useState('');
  const [editState, setEditState] = useState({ busy: false, dirty: false });
  const [archivingId, setArchivingId] = useState('');
  const [archiveBusy, setArchiveBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const restore = useAction();
  const active = projects.filter((project) => !project.archived_at);
  const archived = projects.filter((project) => project.archived_at);
  const editing = active.find((project) => project.id === editingId);
  const archiving = active.find((project) => project.id === archivingId);
  const runs = (project: Project) => orders.filter((order) => order.project_id === project.id).length;
  const facts = (project: Project) => (
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
      <span>{runs(project)} runs</span>
    </div>
  );
  const heading = (project: Project) => (
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
  );
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
            + Add project
          </Button>
        }
      />
      <Dialog
        open={open}
        onClose={() => onOpenChange(false)}
        title="Add project"
        placement="top"
        busy={draftState.busy}
        dirty={draftState.dirty}
        description="Add a repository the factory may work on, with the exact checks its deliveries must pass."
      >
        {open && (
          <div className="grid min-w-0 gap-5">
            <SegmentedControl
              label="Where the project comes from"
              value={source}
              options={SOURCES}
              onChange={(value) => {
                chosen.current = true;
                setSource(value);
              }}
            />
            {source === 'github' && (
              <GitHubRepositories
                api={api}
                enabled={connected && (github?.enabled ?? false)}
                installed={github?.installed ?? false}
                onChanged={onRegistered}
              />
            )}
            {/* Kept mounted while another source is open, so a draft is not lost by looking elsewhere. */}
            <div hidden={source !== 'address'}>
              <ProjectForm
                connected={connected}
                onState={onDraftState}
                api={api}
                onDone={async () => {
                  onOpenChange(false);
                  await onRegistered();
                }}
                onCancel={() => onOpenChange(false)}
              />
            </div>
            {source === 'new' && <RepoCreations api={api} />}
          </div>
        )}
      </Dialog>
      <Dialog
        open={!!editing}
        onClose={() => setEditingId('')}
        title={editing ? `Edit ${editing.name}` : 'Edit project'}
        busy={editState.busy}
        dirty={editState.dirty}
        description="Changes apply to runs launched or resumed afterwards."
      >
        {editing && (
          <ProjectForm
            key={editing.id}
            project={editing}
            connected={connected}
            onState={setEditState}
            api={api}
            onRefused={onRegistered}
            onDone={async () => {
              setEditingId('');
              setNotice(`${editing.name} saved.`);
              await onRegistered();
            }}
            onCancel={() => setEditingId('')}
          />
        )}
      </Dialog>
      <Dialog
        open={!!archiving}
        onClose={() => setArchivingId('')}
        title={archiving ? `Archive ${archiving.name}` : 'Archive project'}
        busy={archiveBusy}
      >
        {archiving && (
          <ArchiveProject
            key={archiving.id}
            api={api}
            project={archiving}
            connected={connected}
            onBusy={setArchiveBusy}
            onRefused={onRegistered}
            onCancel={() => setArchivingId('')}
            onDone={async () => {
              setArchivingId('');
              setNotice(`${archiving.name} archived. Its runs and memory are kept.`);
              await onRegistered();
            }}
          />
        )}
      </Dialog>
      {(notice || archived.length > 0) && (
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <p role="status" className="text-sm text-muted-foreground">
            {notice}
          </p>
          {archived.length > 0 && (
            <CheckField
              checked={showArchived}
              onChange={(event) => setShowArchived(event.target.checked)}
              label={`Show archived (${archived.length})`}
            />
          )}
        </div>
      )}
      {active.length === 0 ? (
        <EmptyState title={archived.length ? 'No active project' : 'Your first project starts here'}>
          {archived.length
            ? 'Register a repository, or show the archived projects to restore one.'
            : 'Register a repository and the checks its deliveries must pass.'}
        </EmptyState>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {active.map((project) => (
            <Card key={project.id} className="gap-3">
              {heading(project)}
              {facts(project)}
              <div className="flex flex-wrap items-center gap-2">
                <Button type="button" onClick={() => onCreateRun(project)}>
                  Create run <span aria-hidden="true">→</span>
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  aria-label={`Edit ${project.name}`}
                  onClick={() => {
                    setNotice('');
                    setEditingId(project.id);
                  }}
                >
                  Edit
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  aria-label={`Archive ${project.name}`}
                  onClick={() => {
                    setNotice('');
                    setArchivingId(project.id);
                  }}
                >
                  Archive
                </Button>
              </div>
            </Card>
          ))}
        </div>
      )}
      {showArchived && archived.length > 0 && (
        <section className="grid gap-4" aria-labelledby="archived-projects-title">
          <div className="grid gap-1">
            <h2 id="archived-projects-title" className="text-lg font-semibold">
              Archived
            </h2>
            <p className="text-sm text-muted-foreground">
              Out of every list and closed to new runs. Runs, memory and evidence are kept.
            </p>
          </div>
          {restore.error && <ErrorNotice>{restore.error}</ErrorNotice>}
          <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {archived.map((project) => (
              <li key={project.id}>
                <Card className="h-full gap-3 border-dashed">
                  <div className="flex items-start justify-between gap-3">
                    <div className="grid min-w-0">
                      <h3 className="truncate text-base font-semibold">{project.name}</h3>
                      <p className="truncate text-xs text-muted-foreground">{project.repository}</p>
                    </div>
                    <Badge variant="neutral">Archived</Badge>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {runs(project)} runs · archived{' '}
                    {new Date(project.archived_at!).toLocaleDateString('en-US', { dateStyle: 'medium' })}
                  </p>
                  <Button
                    type="button"
                    variant="secondary"
                    className="justify-self-start"
                    aria-label={`Restore ${project.name}`}
                    disabled={restore.busy || !connected}
                    onClick={() =>
                      void restore.run(async () => {
                        setNotice('');
                        try {
                          await api.restoreProject(project.id, project.revision);
                        } catch (error) {
                          await onRegistered().catch(() => undefined);
                          throw error;
                        }
                        setNotice(`${project.name} restored.`);
                        await onRegistered();
                      })
                    }
                  >
                    Restore
                  </Button>
                </Card>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function ArchiveProject({
  api,
  project,
  connected,
  onBusy,
  onRefused,
  onCancel,
  onDone,
}: {
  api: Api;
  project: Project;
  connected: boolean;
  onBusy: (busy: boolean) => void;
  onRefused: () => Promise<void>;
  onCancel: () => void;
  onDone: () => Promise<void>;
}) {
  const action = useAction();
  useEffect(() => onBusy(action.busy), [onBusy, action.busy]);
  return (
    <div className="grid gap-5">
      <p className="text-sm">
        {project.name} leaves every list and no run can be launched for it. Its runs, memory and evidence are
        kept, and you can restore it at any time. Nothing changes on GitHub.
      </p>
      {action.error && <ErrorNotice>{action.error}</ErrorNotice>}
      <DialogActions>
        <Button type="button" variant="ghost" disabled={action.busy} onClick={onCancel}>
          Back
        </Button>
        <Button
          type="button"
          variant="primary"
          disabled={action.busy || !connected}
          onClick={() =>
            void action.run(async () => {
              try {
                await api.archiveProject(project.id, project.revision);
              } catch (error) {
                // A refusal may mean another session changed the project: show the current one.
                await onRefused().catch(() => undefined);
                throw error;
              }
              await onDone();
            })
          }
        >
          {action.busy ? 'Archiving…' : 'Archive project'}
        </Button>
      </DialogActions>
    </div>
  );
}

/** Registers a project, or edits one when `project` is given. The repository address is never edited. */
function ProjectForm({
  api,
  project,
  connected,
  onState,
  onDone,
  onCancel,
  onRefused,
}: {
  api: Api;
  project?: Project;
  connected: boolean;
  onState: (state: { busy: boolean; dirty: boolean }) => void;
  onDone: () => Promise<void>;
  onCancel: () => void;
  onRefused?: () => Promise<void>;
}) {
  const action = useAction();
  const [dirty, setDirty] = useState(false);
  useEffect(() => onState({ busy: action.busy, dirty }), [onState, action.busy, dirty]);
  const [profile, setProfile] = useState<'python' | 'node'>(project?.profile ?? 'python');
  const [previewEnabled, setPreviewEnabled] = useState(!!project?.browser_preview);
  const [commands, setCommands] = useState(
    project
      ? project.gate_commands.map((command) => JSON.stringify(command)).join('\n')
      : '["python", "-m", "pytest"]',
  );
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!connected) return;
    const data = new FormData(event.currentTarget);
    void action.run(async () => {
      const gateCommands = lines(data.get('commands')).map((line) =>
        argv(line, 'Each check must be a JSON argument array, for example ["python", "-m", "pytest"].'),
      );
      let previewCommand: string[] = [];
      if (previewEnabled) {
        previewCommand = argv(
          String(data.get('previewCommand')),
          'Preview command must be a nonempty JSON argument array.',
        );
        if (data.get('synthetic') !== 'on')
          throw new Error('Browser previews require explicit synthetic-data confirmation.');
      }
      const editable = {
        name: String(data.get('name')),
        profile,
        default_branch: String(data.get('branch')),
        gate_commands: gateCommands,
        browser_preview: previewEnabled
          ? {
              version: 1 as const,
              command: previewCommand,
              port: Number(data.get('previewPort')),
              synthetic_data: true as const,
            }
          : null,
      };
      if (project) {
        try {
          await api.updateProject(project.id, { expected_revision: project.revision, ...editable });
        } catch (error) {
          // The form keeps what was typed; the list behind it shows the project as it is now.
          await onRefused?.().catch(() => undefined);
          throw error;
        }
      } else
        await api.createProject({
          ...editable,
          repository: String(data.get('repository')),
          allowed_mcp_servers: lines(data.get('mcp')),
          approved_baseline: lines(data.get('baseline')),
        });
      await onDone();
    });
  };
  return (
    <form onSubmit={submit} onChange={() => setDirty(true)} className="grid gap-5">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Project name">
          <Input name="name" maxLength={100} required placeholder="My project" defaultValue={project?.name} />
        </Field>
        {project ? (
          <Field label="Repository" hint="The address identifies the project and cannot change.">
            <Input value={project.repository} readOnly />
          </Field>
        ) : (
          <Field label="Repository">
            <Input name="repository" required placeholder="https://github.com/example/project" />
          </Field>
        )}
        <Field label="Ecosystem">
          <Select
            value={profile}
            onChange={(event) => {
              const next = event.target.value as 'python' | 'node';
              setProfile(next);
              // A suggestion for a new project; an existing project's checks are its own.
              if (!project) setCommands(next === 'python' ? '["python", "-m", "pytest"]' : '["npm", "test"]');
            }}
          >
            <option value="python">Python</option>
            <option value="node">JavaScript / TypeScript</option>
          </Select>
        </Field>
        <Field label="Base branch">
          <Input name="branch" required defaultValue={project?.default_branch ?? 'main'} />
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
                defaultValue={project?.browser_preview ? JSON.stringify(project.browser_preview.command) : ''}
              />
            </Field>
            <Field label="Preview port">
              <Input
                name="previewPort"
                type="number"
                min={1024}
                max={65535}
                required
                defaultValue={project?.browser_preview?.port ?? 5173}
              />
            </Field>
            <CheckField
              name="synthetic"
              required
              defaultChecked={!!project?.browser_preview}
              label="This preview uses synthetic data and contains no production credentials."
            />
          </>
        )}
      </fieldset>
      {!project && (
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
      )}
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
          {project
            ? action.busy
              ? 'Saving…'
              : 'Save changes'
            : action.busy
              ? 'Registering…'
              : 'Register project'}
        </Button>
      </div>
    </form>
  );
}
