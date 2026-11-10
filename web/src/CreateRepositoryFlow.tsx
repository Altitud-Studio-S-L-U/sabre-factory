import { useState, type FormEvent } from 'react';
import {
  ApiError,
  type Api,
  type FlowConfiguration as Configuration,
  type RepoCreationProposal,
} from './api';
import Field from './components/FormField';
import Select from './components/Select';
import FlowConfiguration from './FlowConfiguration';

export default function CreateRepositoryFlow({
  api,
  onCreated,
}: {
  api: Api;
  onCreated: (proposal: RepoCreationProposal) => void;
}) {
  const [config, setConfig] = useState<Configuration>({ version: 1, repair_cycles: 2 });
  const [key, setKey] = useState(() => crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState('');
  const [receipt, setReceipt] = useState('');
  const [profile, setProfile] = useState<'python' | 'node'>('node');
  const [commands, setCommands] = useState('[["npm", "test"]]');
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setBusy(true);
    setError('');
    setReceipt('');
    try {
      const proposal = await api.launchCreate({
        version: 1,
        authorize_repository_creation: true,
        channel: 'web',
        repository: {
          owner_type: data.get('owner_type') as 'org' | 'user',
          owner: String(data.get('owner')),
          name: String(data.get('name')),
          visibility: data.get('visibility') as 'private' | 'public',
          description: String(data.get('description')),
          initialize: true,
          idempotency_key: key,
        },
        profile,
        gate_commands: JSON.parse(commands) as string[][],
        objective: String(data.get('objective')),
        acceptance: String(data.get('acceptance'))
          .split('\n')
          .map((value) => value.trim())
          .filter(Boolean),
        constraints: [],
        flow_config: config,
        budget: {
          max_calls: Number(data.get('calls')),
          max_tokens: Number(data.get('tokens')),
          active_seconds: Number(data.get('minutes')) * 60,
          max_cost_usd: Number(data.get('cost')),
        },
      });
      onCreated(proposal);
      setReceipt(
        `Launch accepted for ${proposal.request.owner}/${proposal.request.name}. Follow its repository receipt below and its run in Runs.`,
      );
      setKey(crypto.randomUUID());
    } catch (reason) {
      setError(
        reason instanceof ApiError
          ? reason.message
          : reason instanceof SyntaxError
            ? 'Verification commands must be a JSON array of argument arrays.'
            : 'The launch outcome is unconfirmed. Refresh proposals before changing or repeating this request.',
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <details className="phase-configuration" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>Create a repository and launch its flow</summary>
      <p>Authorize the exact repository below and the work it may perform. SABRE stops at a draft PR.</p>
      {error && <p role="alert">{error}</p>}
      {receipt && <p role="status">{receipt}</p>}
      {open && (
        <form onSubmit={(event) => void submit(event)}>
          <fieldset disabled={busy} className="form-grid">
            <legend>Repository and scope</legend>
            <Field label="Owner type">
              <Select name="owner_type" defaultValue="org">
                <option value="org">Organization</option>
                <option value="user">User</option>
              </Select>
            </Field>
            <Field label="Repository owner">
              <input name="owner" required pattern="[A-Za-z0-9-]+" />
            </Field>
            <Field label="New repository name">
              <input name="name" required pattern="[A-Za-z0-9_.-]+" />
            </Field>
            <Field label="Repository visibility">
              <Select name="visibility" defaultValue="private">
                <option value="private">Private</option>
                <option value="public">Public</option>
              </Select>
            </Field>
            <Field label="Description">
              <input name="description" maxLength={350} />
            </Field>
            <Field label="Project language">
              <Select
                value={profile}
                onChange={(event) => {
                  const next = event.target.value as 'python' | 'node';
                  setProfile(next);
                  setCommands(next === 'python' ? '[["python", "-m", "pytest"]]' : '[["npm", "test"]]');
                }}
              >
                <option value="node">JavaScript / TypeScript</option>
                <option value="python">Python</option>
              </Select>
            </Field>
            <Field label="New project objective">
              <textarea name="objective" required minLength={5} maxLength={12000} />
            </Field>
            <Field label="New project acceptance criteria" hint="One verifiable outcome per line.">
              <textarea name="acceptance" required />
            </Field>
            <Field
              label="Verification commands"
              hint="JSON arrays of arguments; these checks must pass before delivery."
            >
              <textarea required value={commands} onChange={(event) => setCommands(event.target.value)} />
            </Field>
            <Field label="Model call limit">
              <input name="calls" type="number" min={1} max={500} defaultValue={40} required />
            </Field>
            <Field label="Token limit">
              <input name="tokens" type="number" min={1} max={10000000} defaultValue={100000} required />
            </Field>
            <Field label="Active minutes">
              <input name="minutes" type="number" min={1} max={1440} defaultValue={60} required />
            </Field>
            <Field label="API budget (USD)">
              <input name="cost" type="number" min={0} max={1000} step="0.01" defaultValue={0} required />
            </Field>
          </fieldset>
          <FlowConfiguration api={api} mode="create" value={config} onChange={setConfig} />
          <label className="inline-check">
            <input type="checkbox" required disabled={busy} /> I authorize creation with these details and
            execution within these limits.
          </label>
          <button className="button primary" disabled={busy} type="submit">
            {busy ? 'Launching…' : 'Authorize and launch create flow'}
          </button>
        </form>
      )}
    </details>
  );
}
