import Button from './components/Button';
import LoadingState from './components/LoadingState';
import Input from './components/Input';
import Textarea from './components/Textarea';
import { useEffect, useState, type ReactNode } from 'react';
import type {
  AgentCatalogEntry,
  AgentDefinition,
  Api,
  BuiltinToolCatalog,
  ModelConfiguration,
  Project,
} from './api';
import Dialog, { DialogActions } from './components/Dialog';
import Tabs from './components/Tabs';
import JsonView from './components/JsonView';
import Notice from './components/Notice';
import EmptyState from './components/EmptyState';
import Field from './components/FormField';
import CheckField from './components/CheckField';
import DescriptionList from './components/DescriptionList';
import { Eyebrow, SectionHeading } from './components/PageHeader';
import { Badge } from './components/ui/badge';
import { SelectionFields } from './ModelConfiguration';
import RemoteAgentsPanel from './RemoteAgentsPanel';
import InboundAccessPanel from './InboundAccessPanel';

type Source = 'local' | 'external';
const sources: { value: Source; label: string }[] = [
  { value: 'local', label: 'Local specialists' },
  { value: 'external', label: 'External · MCP / A2A' },
];
type Section = 'overview' | 'chain' | 'instructions' | 'tools' | 'context' | 'versions';
// Tab values become element ids, so they carry no spaces; the labels are the visible names.
const sections: { value: Section; label: string }[] = [
  { value: 'overview', label: 'Overview' },
  { value: 'chain', label: 'Chain' },
  { value: 'instructions', label: 'Instructions & skills' },
  { value: 'tools', label: 'Tools' },
  { value: 'context', label: 'Context' },
  { value: 'versions', label: 'Versions' },
];
const responsibilities: Record<string, string> = {
  pm: 'Translate the objective into requirements, scope and acceptance criteria.',
  designer: 'Define interaction and interface requirements, with visual evidence when supported.',
  developer: 'Design code architecture, organize the repository and implement accepted tasks.',
  qa: 'Reproduce failures and verify acceptance against executable checks.',
  manager: 'Coordinate the process and judge independently, in separate invocation contexts.',
  devops: 'Prepare the environment and delivery evidence. Publication remains a controlled system operation.',
  ciso: 'Assess security risks and evidence. This specialist cannot waive controls.',
};

/** Monogram placeholder for a specialist; the crew avatar replaces it. */
function SpecialistAvatar({ label }: { label: string }) {
  return (
    <span
      aria-hidden="true"
      className="grid size-8 shrink-0 place-items-center rounded-md border border-border bg-code font-mono text-xs font-medium text-primary"
    >
      {label.slice(0, 2).toUpperCase()}
    </span>
  );
}

/** A bordered group of related controls with a small legend. */
function FieldGroup({
  legend,
  disabled,
  children,
}: {
  legend: string;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <fieldset
      disabled={disabled}
      className="grid min-w-0 gap-3 rounded-lg border border-border px-4 pt-2 pb-4"
    >
      <legend className="px-1.5 text-xs font-medium text-muted-foreground">{legend}</legend>
      {children}
    </fieldset>
  );
}

function Fact({ label, value, detail }: { label: string; value: ReactNode; detail?: ReactNode }) {
  return (
    <div className="grid min-w-0 content-start gap-1">
      <span className="text-xs text-muted-foreground">{label}</span>
      <strong className="text-lg font-semibold [overflow-wrap:anywhere]">{value}</strong>
      {detail && <small className="text-xs text-muted-foreground [overflow-wrap:anywhere]">{detail}</small>}
    </div>
  );
}

export default function AgentsConsole({
  api,
  projects,
  connected = true,
}: {
  api: Api;
  projects: Project[];
  connected?: boolean;
}) {
  const [source, setSource] = useState<Source>('local');
  const [entries, setEntries] = useState<AgentCatalogEntry[]>([]);
  const [models, setModels] = useState<ModelConfiguration | null>(null);
  const [tools, setTools] = useState<BuiltinToolCatalog['items']>([]);
  const [selected, setSelected] = useState('developer');
  const [section, setSection] = useState<Section>('overview');
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<AgentDefinition | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [validation, setValidation] = useState<string[]>([]);
  const [version, setVersion] = useState<number | null>(null);
  const reload = async () => {
    const [catalog, configuration, builtins] = await Promise.all([
      api.agents(),
      api.modelConfiguration(),
      api.toolsCatalog(),
    ]);
    setEntries(catalog.agents);
    setModels(configuration);
    setTools(builtins.items);
    setError('');
  };
  useEffect(() => {
    let live = true;
    Promise.all([api.agents(), api.modelConfiguration(), api.toolsCatalog()])
      .then(([catalog, configuration, builtins]) => {
        if (live) {
          setEntries(catalog.agents);
          setModels(configuration);
          setTools(builtins.items);
        }
      })
      .catch((reason) => {
        if (live) setError(reason instanceof Error ? reason.message : 'Agent catalog could not be loaded.');
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [api]);
  const agent = entries.find((entry) => entry.id === selected) ?? entries[0];
  const definition = agent?.published.definition;
  const roleModel =
    models?.roles.find((item) => agent?.legacy_roles.includes(item.role))?.effective ?? models?.default;
  const effectiveModel = definition?.model ?? roleModel;
  const availableTools = tools.filter((tool) =>
    agent?.legacy_roles.some((role) => tool.roles.includes(role)),
  );
  const skills = [
    ...new Map(
      entries.flatMap((entry) => entry.published.definition.skills).map((skill) => [skill.name, skill]),
    ).values(),
  ];
  const dirty = !!agent && !!draft && JSON.stringify(draft) !== JSON.stringify(agent.draft);
  const changeDraft = (value: Partial<AgentDefinition>) =>
    setDraft((prior) => (prior ? { ...prior, ...value } : prior));
  const perform = async (operation: () => Promise<void>) => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await operation();
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : 'The agent operation could not be confirmed. Refresh before retrying.',
      );
    } finally {
      setBusy(false);
    }
  };
  const renderDefinition = (value: AgentDefinition, editable: boolean) => (
    <>
      <Field label="Instructions">
        <Textarea
          rows={8}
          className="min-h-24 resize-y font-mono text-xs leading-relaxed"
          value={value.instructions}
          readOnly={!editable}
          maxLength={16000}
          onChange={(event) => changeDraft({ instructions: event.target.value })}
        />
      </Field>
      <FieldGroup legend="Versioned skills" disabled={!editable || busy}>
        {skills.map((skill) => (
          <CheckField
            key={skill.name}
            label={skill.name}
            hint={<code className="font-mono">{skill.digest.slice(0, 16)}</code>}
            checked={value.skills.some((item) => item.name === skill.name)}
            onChange={(event) =>
              changeDraft({
                skills: event.target.checked
                  ? [...value.skills, skill]
                  : value.skills.filter((item) => item.name !== skill.name),
              })
            }
          />
        ))}
      </FieldGroup>
    </>
  );
  return (
    <Tabs
      items={sources}
      value={source}
      onChange={setSource}
      label="Agent sources"
      className="[&>[role=tabpanel]]:p-0"
    >
      {(active) =>
        active === 'external' ? (
          <div className="grid min-w-0 gap-8 pt-6">
            <RemoteAgentsPanel api={api} projects={projects} connected={connected} />
            <InboundAccessPanel api={api} projects={projects} connected={connected} />
          </div>
        ) : (
          <section className="grid min-w-0 gap-5 pt-6" aria-label="Agent catalog">
            <SectionHeading
              className="items-start [&>:first-child]:flex-1 [&>:first-child]:basis-72"
              title="Specialist team"
              description="Published procedures are pinned to each run. Editing a draft never changes active work."
              actions={
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  disabled={busy || !connected}
                  onClick={() => void perform(reload)}
                >
                  Refresh catalog
                </Button>
              }
            />
            {error && !editing && (
              <Notice tone="danger" role="alert">
                {error}
              </Notice>
            )}
            {notice && (
              <Notice tone="neutral" role="status">
                {notice}
              </Notice>
            )}
            {!connected && <Notice tone="warning">Disconnected snapshot. Agent changes are disabled.</Notice>}
            {loading ? (
              <LoadingState label="Loading published specialists…" />
            ) : !agent || !definition ? (
              <EmptyState title="The agent catalog is unavailable. Refresh after checking the factory connection." />
            ) : (
              <div className="grid min-w-0 items-start gap-5 lg:grid-cols-[15rem_minmax(0,1fr)]">
                <aside
                  className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-1"
                  aria-label="Local specialists"
                >
                  {entries.map((entry) => (
                    <Button
                      type="button"
                      key={entry.id}
                      aria-pressed={entry.id === agent.id}
                      className="flex min-h-14 w-full min-w-0 items-center gap-3 rounded-lg border border-border bg-card px-3 py-2.5 text-left transition-colors hover:bg-hover aria-pressed:border-primary aria-pressed:bg-accent"
                      onClick={() => {
                        setSelected(entry.id);
                        setVersion(null);
                        setValidation([]);
                      }}
                    >
                      <SpecialistAvatar label={entry.label} />
                      <span className="grid min-w-0 flex-1 gap-0.5">
                        <strong className="truncate text-sm font-semibold">{entry.label}</strong>
                        <small className="text-xs text-muted-foreground">
                          Local · published v{entry.published.version}
                        </small>
                      </span>
                      <span
                        role="img"
                        className="size-1.5 shrink-0 rounded-full bg-success"
                        aria-label="Registered"
                      />
                    </Button>
                  ))}
                </aside>
                <article className="@container min-w-0 overflow-hidden rounded-lg border border-border bg-card">
                  <header className="flex min-w-0 flex-wrap items-start justify-between gap-4 p-5">
                    <div className="grid min-w-0 gap-1.5">
                      <Eyebrow>LOCAL SPECIALIST</Eyebrow>
                      <h2 className="text-2xl font-semibold tracking-tight">{agent.label}</h2>
                      <p className="max-w-[65ch] text-sm text-muted-foreground">
                        {responsibilities[agent.id]}
                      </p>
                    </div>
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      disabled={!connected || busy}
                      onClick={() => {
                        setDraft(structuredClone(agent.draft));
                        setEditing(true);
                      }}
                    >
                      Edit draft
                    </Button>
                  </header>
                  <Tabs
                    items={sections}
                    value={section}
                    onChange={setSection}
                    label="Agent details"
                    className="[&>[role=tablist]]:px-2 [&>[role=tabpanel]]:p-0"
                  >
                    {(active) => (
                      <div className="grid min-w-0 gap-5 p-5">
                        {active === 'overview' && (
                          <>
                            <div className="grid grid-cols-2 gap-x-4 gap-y-5 border-b border-border pb-5 @2xl:grid-cols-4">
                              <Fact label="Published version" value={`v${agent.published.version}`} />
                              <Fact
                                label="Provider / model"
                                value={effectiveModel?.provider ?? 'Not configured'}
                                detail={effectiveModel?.name || 'Model selection required'}
                              />
                              <Fact label="Procedures" value={definition.chains.length} />
                              <Fact
                                label="Context boundary"
                                value={`${Math.round(definition.context.max_input_bytes / 1024)} KiB`}
                              />
                            </div>
                            <p className="text-sm text-muted-foreground">
                              {definition.model
                                ? 'This specialist has an explicit model selection. Run and flow phase selections retain their documented precedence.'
                                : 'Model inherited from its configured role or the factory default. Run and flow phase overrides may take precedence.'}
                            </p>
                            <div className="grid gap-3">
                              <h3 className="text-base font-semibold">Runtime bindings</h3>
                              <div className="flex flex-wrap gap-2">
                                {agent.legacy_roles.map((role) => (
                                  <Badge key={role} variant="outline" className="font-mono">
                                    {role}
                                  </Badge>
                                ))}
                              </div>
                            </div>
                            <p className="text-sm text-muted-foreground">
                              Skills guide work. Tool and project policies remain enforced by the broker.
                              Independent review never shares the author’s conversation.
                            </p>
                          </>
                        )}
                        {active === 'chain' &&
                          definition.chains.map((chain) => (
                            <section key={chain.id} className="grid min-w-0 gap-4">
                              <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                                <h3 className="text-base font-semibold capitalize">{chain.id}</h3>
                                <span className="text-xs text-muted-foreground">
                                  Registered procedure · schema v{chain.version}
                                </span>
                              </header>
                              <ol className="grid">
                                {chain.steps.map((step) => (
                                  <li
                                    key={step.id}
                                    className="relative ml-1.5 border-l border-border pb-5 pl-5 last:pb-1"
                                  >
                                    <span
                                      aria-hidden="true"
                                      className="absolute top-1.5 -left-[5px] size-2.5 rounded-full border-2 border-primary bg-card"
                                    />
                                    <div className="grid min-w-0 gap-1">
                                      <strong className="text-sm font-semibold capitalize">
                                        {step.capability}
                                      </strong>
                                      <code className="font-mono text-xs text-muted-foreground">
                                        {step.id}
                                      </code>
                                      <p className="text-sm text-muted-foreground">
                                        {step.instructions ||
                                          'Uses the registered capability and its deterministic validation.'}
                                      </p>
                                    </div>
                                  </li>
                                ))}
                              </ol>
                            </section>
                          ))}
                        {active === 'instructions' && renderDefinition(definition, false)}
                        {active === 'tools' && (
                          <>
                            <p className="text-sm text-muted-foreground">
                              {definition.tools === null
                                ? 'Inherits code-authorized tools. Project and run grants can restrict them further.'
                                : 'Published tool restriction. This definition cannot grant tools beyond runtime permissions.'}
                            </p>
                            <div className="grid gap-3 @xl:grid-cols-2">
                              {availableTools.map((tool) => (
                                <article
                                  key={tool.name}
                                  className="grid min-w-0 content-start gap-2 rounded-lg border border-border bg-secondary/40 p-4"
                                >
                                  <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
                                    <strong className="font-mono text-sm font-medium [overflow-wrap:anywhere]">
                                      {tool.name}
                                    </strong>
                                    <Badge variant="neutral">{tool.effect.replaceAll('_', ' ')}</Badge>
                                  </div>
                                  <p className="text-sm text-muted-foreground">{tool.description}</p>
                                  <small className="text-xs text-muted-foreground">
                                    {definition.tools === null || definition.tools.includes(tool.name)
                                      ? 'Selected by specialist policy · project/run checks still apply'
                                      : 'Restricted by published definition'}
                                  </small>
                                </article>
                              ))}
                            </div>
                          </>
                        )}
                        {active === 'context' && (
                          <>
                            <DescriptionList
                              termWidth="11rem"
                              items={[
                                [
                                  'Maximum model input',
                                  `${definition.context.max_input_bytes.toLocaleString('en-US')} bytes`,
                                ],
                                [
                                  'Visual evidence review',
                                  definition.context.visual_review
                                    ? 'Required · compatible provider and evidence must be present'
                                    : 'Not required by this specialist definition',
                                ],
                                [
                                  'Memory',
                                  'Project and commit scoped, with recorded provenance and bounded retrieval.',
                                ],
                                [
                                  'Instruction authority',
                                  'Repository files, source excerpts and memory cannot expand permissions.',
                                ],
                              ]}
                            />
                            <JsonView value={definition.context} label="Published context policy" />
                          </>
                        )}
                        {active === 'versions' && (
                          <>
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="mr-auto text-sm text-muted-foreground">
                                Draft revision {agent.revision}
                              </span>
                              <Button
                                type="button"
                                variant="secondary"
                                size="sm"
                                disabled={busy || !connected}
                                onClick={() =>
                                  void perform(async () => {
                                    const result = await api.validateAgent(agent.id, agent.revision);
                                    setValidation(result.errors);
                                    setNotice(
                                      result.valid
                                        ? 'Draft validation passed.'
                                        : 'Draft requires corrections.',
                                    );
                                  })
                                }
                              >
                                Validate draft
                              </Button>
                              <Button
                                type="button"
                                variant="primary"
                                size="sm"
                                disabled={busy || !connected || !agent.validation.valid}
                                onClick={() =>
                                  void perform(async () => {
                                    await api.publishAgent(agent.id, agent.revision);
                                    await reload();
                                    setNotice(
                                      'New immutable version published. Existing runs retain their original versions.',
                                    );
                                  })
                                }
                              >
                                Publish version
                              </Button>
                            </div>
                            {validation.map((item, index) => (
                              <Notice tone="danger" key={index}>
                                {item}
                              </Notice>
                            ))}
                            <div className="grid gap-2">
                              {agent.versions.map((item) => (
                                <Button
                                  type="button"
                                  key={item.version}
                                  aria-pressed={version === item.version}
                                  className="grid w-full min-w-0 gap-1 rounded-lg border border-border bg-secondary/40 px-4 py-3 text-left transition-colors hover:bg-hover aria-pressed:border-primary aria-pressed:bg-accent"
                                  onClick={() => setVersion(item.version)}
                                >
                                  <strong className="text-sm font-semibold">Version {item.version}</strong>
                                  <code className="font-mono text-xs text-muted-foreground [overflow-wrap:anywhere]">
                                    {item.digest}
                                  </code>
                                </Button>
                              ))}
                            </div>
                            {version != null && (
                              <JsonView
                                value={agent.versions.find((item) => item.version === version)}
                                label="Immutable specialist version"
                              />
                            )}
                          </>
                        )}
                      </div>
                    )}
                  </Tabs>
                </article>
              </div>
            )}
            <Dialog
              open={editing && !!draft}
              onClose={() => setEditing(false)}
              title={`Edit ${agent?.label ?? 'agent'} draft`}
              description="Save a draft first. Validation and publication are separate actions; active runs keep their published snapshot."
              busy={busy}
              dirty={dirty}
            >
              {draft && agent && (
                <form
                  className="grid min-w-0 gap-5"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void perform(async () => {
                      await api.saveAgent(agent.id, { expected_revision: agent.revision, definition: draft });
                      await reload();
                      setEditing(false);
                      setNotice('Draft saved. Validate and publish it from Versions.');
                    });
                  }}
                >
                  {error && (
                    <Notice tone="danger" role="alert">
                      {error}
                    </Notice>
                  )}
                  <fieldset disabled={busy || !connected} className="grid min-w-0 gap-5">
                    {renderDefinition(draft, true)}
                    <FieldGroup legend="Model selection" disabled={busy}>
                      <CheckField
                        label="Inherit role / factory default"
                        checked={draft.model === null}
                        onChange={(event) =>
                          changeDraft({
                            model: event.target.checked ? null : roleModel ? { ...roleModel } : null,
                          })
                        }
                      />
                      {draft.model && (
                        <SelectionFields value={draft.model} onChange={(model) => changeDraft({ model })} />
                      )}
                    </FieldGroup>
                    <FieldGroup legend="Registered procedure instructions" disabled={busy}>
                      {draft.chains.map((chain, chainIndex) => (
                        <div className="grid min-w-0 gap-3" key={chain.id}>
                          <strong className="text-sm font-semibold capitalize">{chain.id}</strong>
                          {chain.steps.map((step, stepIndex) => (
                            <Field key={step.id} label={`${step.capability} · ${step.id}`}>
                              <Textarea
                                rows={3}
                                className="resize-y font-mono text-xs leading-relaxed"
                                value={step.instructions}
                                maxLength={8000}
                                onChange={(event) =>
                                  changeDraft({
                                    chains: draft.chains.map((item, index) =>
                                      index !== chainIndex
                                        ? item
                                        : {
                                            ...item,
                                            steps: item.steps.map((value, index) =>
                                              index !== stepIndex
                                                ? value
                                                : { ...value, instructions: event.target.value },
                                            ),
                                          },
                                    ),
                                  })
                                }
                              />
                            </Field>
                          ))}
                        </div>
                      ))}
                    </FieldGroup>
                    <FieldGroup legend="Tool restriction" disabled={busy}>
                      <CheckField
                        label="Inherit runtime-authorized tools"
                        checked={draft.tools === null}
                        onChange={(event) => changeDraft({ tools: event.target.checked ? null : [] })}
                      />
                      {draft.tools !== null &&
                        availableTools.map((tool) => (
                          <CheckField
                            key={tool.name}
                            label={tool.name}
                            checked={draft.tools!.includes(tool.name)}
                            onChange={(event) =>
                              changeDraft({
                                tools: event.target.checked
                                  ? [...draft.tools!, tool.name]
                                  : draft.tools!.filter((name) => name !== tool.name),
                              })
                            }
                          />
                        ))}
                    </FieldGroup>
                    <FieldGroup legend="Context policy" disabled={busy}>
                      <Field label="Maximum input bytes">
                        <Input
                          type="number"
                          min={4096}
                          max={98304}
                          value={draft.context.max_input_bytes}
                          onChange={(event) =>
                            changeDraft({
                              context: { ...draft.context, max_input_bytes: Number(event.target.value) },
                            })
                          }
                        />
                      </Field>
                      <CheckField
                        label="Require image-capable evidence review"
                        checked={draft.context.visual_review}
                        onChange={(event) =>
                          changeDraft({ context: { ...draft.context, visual_review: event.target.checked } })
                        }
                      />
                    </FieldGroup>
                    <DialogActions>
                      <Button variant="primary" type="submit" disabled={busy || !dirty || !connected}>
                        {busy ? 'Saving…' : 'Save draft'}
                      </Button>
                    </DialogActions>
                  </fieldset>
                </form>
              )}
            </Dialog>
          </section>
        )
      }
    </Tabs>
  );
}
