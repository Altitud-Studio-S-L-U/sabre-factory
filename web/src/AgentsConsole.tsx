import Button from './components/Button';
import Input from './components/Input';
import Textarea from './components/Textarea';
import { useEffect, useState } from 'react';
import type {
  AgentCatalogEntry,
  AgentDefinition,
  Api,
  BuiltinToolCatalog,
  ModelConfiguration,
  Project,
} from './api';
import Dialog from './components/Dialog';
import Tabs from './components/Tabs';
import JsonView from './components/JsonView';
import { SelectionFields } from './ModelConfiguration';
import RemoteAgentsPanel from './RemoteAgentsPanel';
import InboundAccessPanel from './InboundAccessPanel';
import './AgentsConsole.css';

type Section = 'Overview' | 'Chain' | 'Instructions & skills' | 'Tools' | 'Context' | 'Versions';
const sections: { value: Section; label: string }[] = [
  'Overview',
  'Chain',
  'Instructions & skills',
  'Tools',
  'Context',
  'Versions',
].map((label) => ({ value: label as Section, label }));
const responsibilities: Record<string, string> = {
  pm: 'Translate the objective into requirements, scope and acceptance criteria.',
  designer: 'Define interaction and interface requirements, with visual evidence when supported.',
  developer: 'Design code architecture, organize the repository and implement accepted tasks.',
  qa: 'Reproduce failures and verify acceptance against executable checks.',
  manager: 'Coordinate the process and judge independently, in separate invocation contexts.',
  devops: 'Prepare the environment and delivery evidence. Publication remains a controlled system operation.',
  ciso: 'Assess security risks and evidence. This specialist cannot waive controls.',
};

export default function AgentsConsole({
  api,
  projects,
  connected = true,
}: {
  api: Api;
  projects: Project[];
  connected?: boolean;
}) {
  const [source, setSource] = useState<'local' | 'external'>('local');
  const [entries, setEntries] = useState<AgentCatalogEntry[]>([]);
  const [models, setModels] = useState<ModelConfiguration | null>(null);
  const [tools, setTools] = useState<BuiltinToolCatalog['items']>([]);
  const [selected, setSelected] = useState('developer');
  const [section, setSection] = useState<Section>('Overview');
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
      <label className="agent-field">
        Instructions
        <Textarea
          rows={8}
          value={value.instructions}
          readOnly={!editable}
          maxLength={16000}
          onChange={(event) => changeDraft({ instructions: event.target.value })}
        />
      </label>
      <fieldset disabled={!editable || busy}>
        <legend>Versioned skills</legend>
        {skills.map((skill) => (
          <label className="agent-check" key={skill.name}>
            <Input
              type="checkbox"
              checked={value.skills.some((item) => item.name === skill.name)}
              onChange={(event) =>
                changeDraft({
                  skills: event.target.checked
                    ? [...value.skills, skill]
                    : value.skills.filter((item) => item.name !== skill.name),
                })
              }
            />
            <span>
              {skill.name}
              <code>{skill.digest.slice(0, 16)}</code>
            </span>
          </label>
        ))}
      </fieldset>
    </>
  );
  return (
    <>
      <div className="agent-source-switch" aria-label="Agent sources">
        <Button
          type="button"
          className="button"
          aria-pressed={source === 'local'}
          onClick={() => setSource('local')}
        >
          Local specialists
        </Button>
        <Button
          type="button"
          className="button"
          aria-pressed={source === 'external'}
          onClick={() => setSource('external')}
        >
          External · MCP / A2A
        </Button>
      </div>
      {source === 'external' ? (
        <>
          <RemoteAgentsPanel api={api} projects={projects} connected={connected} />
          <InboundAccessPanel api={api} projects={projects} connected={connected} />
        </>
      ) : (
        <section className="agents-console" aria-label="Agent catalog">
          <header className="console-section-toolbar">
            <div>
              <h2>Specialist team</h2>
              <p>Published procedures are pinned to each run. Editing a draft never changes active work.</p>
            </div>
            <Button
              type="button"
              className="button small"
              disabled={busy || !connected}
              onClick={() => void perform(reload)}
            >
              Refresh catalog
            </Button>
          </header>
          {error && !editing && (
            <p className="notice error" role="alert">
              {error}
            </p>
          )}
          {notice && (
            <p className="notice neutral" role="status">
              {notice}
            </p>
          )}
          {!connected && <p className="notice warning">Disconnected snapshot. Agent changes are disabled.</p>}
          {loading ? (
            <p role="status">Loading published specialists…</p>
          ) : !agent || !definition ? (
            <div className="console-empty">
              The agent catalog is unavailable. Refresh after checking the factory connection.
            </div>
          ) : (
            <div className="agents-workspace">
              <aside className="specialist-list" aria-label="Local specialists">
                {entries.map((entry) => (
                  <Button
                    type="button"
                    key={entry.id}
                    aria-pressed={entry.id === agent.id}
                    className="specialist-choice"
                    onClick={() => {
                      setSelected(entry.id);
                      setVersion(null);
                      setValidation([]);
                    }}
                  >
                    <span className="specialist-avatar">{entry.label.slice(0, 2).toUpperCase()}</span>
                    <span>
                      <strong>{entry.label}</strong>
                      <small>Local · published v{entry.published.version}</small>
                    </span>
                    <i className="agent-available" aria-label="Registered" />
                  </Button>
                ))}
              </aside>
              <article className="specialist-detail">
                <header className="specialist-header">
                  <div>
                    <span className="eyebrow">LOCAL SPECIALIST</span>
                    <h2>{agent.label}</h2>
                    <p>{responsibilities[agent.id]}</p>
                  </div>
                  <Button
                    type="button"
                    className="button"
                    disabled={!connected || busy}
                    onClick={() => {
                      setDraft(structuredClone(agent.draft));
                      setEditing(true);
                    }}
                  >
                    Edit draft
                  </Button>
                </header>
                <Tabs items={sections} value={section} onChange={setSection} label="Agent details">
                  {(active) => (
                    <>
                      {active === 'Overview' && (
                        <>
                          <div className="agent-facts">
                            <div>
                              <span>Published version</span>
                              <strong>v{agent.published.version}</strong>
                            </div>
                            <div>
                              <span>Provider / model</span>
                              <strong>{effectiveModel?.provider ?? 'Not configured'}</strong>
                              <small>{effectiveModel?.name || 'Model selection required'}</small>
                            </div>
                            <div>
                              <span>Procedures</span>
                              <strong>{definition.chains.length}</strong>
                            </div>
                            <div>
                              <span>Context boundary</span>
                              <strong>{Math.round(definition.context.max_input_bytes / 1024)} KiB</strong>
                            </div>
                          </div>
                          <p className="agent-runtime-note">
                            {definition.model
                              ? 'This specialist has an explicit model selection. Run and flow phase selections retain their documented precedence.'
                              : 'Model inherited from its configured role or the factory default. Run and flow phase overrides may take precedence.'}
                          </p>
                          <h3>Runtime bindings</h3>
                          <div className="agent-bindings">
                            {agent.legacy_roles.map((role) => (
                              <code key={role}>{role}</code>
                            ))}
                          </div>
                          <p className="hint">
                            Skills guide work. Tool and project policies remain enforced by the broker.
                            Independent review never shares the author’s conversation.
                          </p>
                        </>
                      )}
                      {active === 'Chain' && (
                        <div className="agent-chains">
                          {definition.chains.map((chain) => (
                            <section key={chain.id}>
                              <header>
                                <h3>{chain.id}</h3>
                                <span>Registered procedure · schema v{chain.version}</span>
                              </header>
                              <ol>
                                {chain.steps.map((step) => (
                                  <li key={step.id}>
                                    <span className="chain-node" />
                                    <div>
                                      <strong>{step.capability}</strong>
                                      <code>{step.id}</code>
                                      <p>
                                        {step.instructions ||
                                          'Uses the registered capability and its deterministic validation.'}
                                      </p>
                                    </div>
                                  </li>
                                ))}
                              </ol>
                            </section>
                          ))}
                        </div>
                      )}
                      {active === 'Instructions & skills' && renderDefinition(definition, false)}
                      {active === 'Tools' && (
                        <>
                          <p className="hint">
                            {definition.tools === null
                              ? 'Inherits code-authorized tools. Project and run grants can restrict them further.'
                              : 'Published tool restriction. This definition cannot grant tools beyond runtime permissions.'}
                          </p>
                          <div className="agent-tools">
                            {availableTools.map((tool) => (
                              <article key={tool.name}>
                                <div>
                                  <strong>{tool.name}</strong>
                                  <span>{tool.effect.replaceAll('_', ' ')}</span>
                                </div>
                                <p>{tool.description}</p>
                                <small>
                                  {definition.tools === null || definition.tools.includes(tool.name)
                                    ? 'Selected by specialist policy · project/run checks still apply'
                                    : 'Restricted by published definition'}
                                </small>
                              </article>
                            ))}
                          </div>
                        </>
                      )}
                      {active === 'Context' && (
                        <>
                          <dl className="agent-context">
                            <dt>Maximum model input</dt>
                            <dd>{definition.context.max_input_bytes.toLocaleString('en-US')} bytes</dd>
                            <dt>Visual evidence review</dt>
                            <dd>
                              {definition.context.visual_review
                                ? 'Required · compatible provider and evidence must be present'
                                : 'Not required by this specialist definition'}
                            </dd>
                            <dt>Memory</dt>
                            <dd>
                              Project and commit scoped, with recorded provenance and bounded retrieval.
                            </dd>
                            <dt>Instruction authority</dt>
                            <dd>Repository files, source excerpts and memory cannot expand permissions.</dd>
                          </dl>
                          <JsonView value={definition.context} label="Published context policy" />
                        </>
                      )}
                      {active === 'Versions' && (
                        <>
                          <div className="agent-publish-toolbar">
                            <span>Draft revision {agent.revision}</span>
                            <Button
                              type="button"
                              className="button small"
                              disabled={busy || !connected}
                              onClick={() =>
                                void perform(async () => {
                                  const result = await api.validateAgent(agent.id, agent.revision);
                                  setValidation(result.errors);
                                  setNotice(
                                    result.valid ? 'Draft validation passed.' : 'Draft requires corrections.',
                                  );
                                })
                              }
                            >
                              Validate draft
                            </Button>
                            <Button
                              type="button"
                              className="button primary small"
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
                            <p className="notice error" key={index}>
                              {item}
                            </p>
                          ))}
                          <div className="agent-versions">
                            {agent.versions.map((item) => (
                              <Button
                                type="button"
                                className="agent-version"
                                key={item.version}
                                aria-pressed={version === item.version}
                                onClick={() => setVersion(item.version)}
                              >
                                <strong>Version {item.version}</strong>
                                <code>{item.digest}</code>
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
                    </>
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
                  <p className="notice error" role="alert">
                    {error}
                  </p>
                )}
                <fieldset disabled={busy || !connected} className="agent-editor-fields">
                  {renderDefinition(draft, true)}
                  <fieldset disabled={busy}>
                    <legend>Model selection</legend>
                    <label className="agent-check">
                      <Input
                        type="checkbox"
                        checked={draft.model === null}
                        onChange={(event) =>
                          changeDraft({
                            model: event.target.checked ? null : roleModel ? { ...roleModel } : null,
                          })
                        }
                      />
                      Inherit role / factory default
                    </label>
                    {draft.model && (
                      <SelectionFields value={draft.model} onChange={(model) => changeDraft({ model })} />
                    )}
                  </fieldset>
                  <fieldset disabled={busy}>
                    <legend>Registered procedure instructions</legend>
                    {draft.chains.map((chain, chainIndex) => (
                      <div className="agent-chain-editor" key={chain.id}>
                        <strong>{chain.id}</strong>
                        {chain.steps.map((step, stepIndex) => (
                          <label className="agent-field" key={step.id}>
                            {step.capability} · {step.id}
                            <Textarea
                              rows={3}
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
                          </label>
                        ))}
                      </div>
                    ))}
                  </fieldset>
                  <fieldset disabled={busy}>
                    <legend>Tool restriction</legend>
                    <label className="agent-check">
                      <Input
                        type="checkbox"
                        checked={draft.tools === null}
                        onChange={(event) => changeDraft({ tools: event.target.checked ? null : [] })}
                      />
                      Inherit runtime-authorized tools
                    </label>
                    {draft.tools !== null &&
                      availableTools.map((tool) => (
                        <label className="agent-check" key={tool.name}>
                          <Input
                            type="checkbox"
                            checked={draft.tools!.includes(tool.name)}
                            onChange={(event) =>
                              changeDraft({
                                tools: event.target.checked
                                  ? [...draft.tools!, tool.name]
                                  : draft.tools!.filter((name) => name !== tool.name),
                              })
                            }
                          />
                          {tool.name}
                        </label>
                      ))}
                  </fieldset>
                  <fieldset disabled={busy}>
                    <legend>Context policy</legend>
                    <label className="agent-field">
                      Maximum input bytes
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
                    </label>
                    <label className="agent-check">
                      <Input
                        type="checkbox"
                        checked={draft.context.visual_review}
                        onChange={(event) =>
                          changeDraft({ context: { ...draft.context, visual_review: event.target.checked } })
                        }
                      />
                      Require image-capable evidence review
                    </label>
                  </fieldset>
                  <div className="dialog-actions">
                    <Button className="button primary" type="submit" disabled={busy || !dirty || !connected}>
                      {busy ? 'Saving…' : 'Save draft'}
                    </Button>
                  </div>
                </fieldset>
              </form>
            )}
          </Dialog>
        </section>
      )}
    </>
  );
}
