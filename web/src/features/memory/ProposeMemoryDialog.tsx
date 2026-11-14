import { useState } from 'react';
import type { Api, MemoryItem } from '../../api';
import Button from '../../components/Button';
import Dialog, { DialogActions } from '../../components/Dialog';
import Field from '../../components/FormField';
import Notice from '../../components/Notice';
import Select from '../../components/Select';
import Textarea from '../../components/Textarea';
import { message } from '../runs/shared';

export type IndexedCommit = { commit: string; readAt: string | null };
type Draft = {
  kind: 'fact' | 'lesson';
  scope: 'commit' | 'project';
  content: string;
  citations: string;
  commit: string;
};

const blank: Draft = { kind: 'lesson', scope: 'project', content: '', citations: '', commit: '' };
const citationList = (value: string) => [
  ...new Set(
    value
      .split(/[\n,]/)
      .map((line) => line.trim())
      .filter(Boolean),
  ),
];

/**
 * The owner's own knowledge, anchored to a commit the factory has indexed: the service checks the
 * cited files against that index. Saving records a proposal; approving it is a separate decision.
 */
export default function ProposeMemoryDialog({
  api,
  projectId,
  commits,
  open,
  connected,
  onClose,
  onProposed,
}: {
  api: Api;
  projectId: string;
  commits: IndexedCommit[];
  open: boolean;
  connected: boolean;
  onClose: () => void;
  onProposed: (item: MemoryItem) => void;
}) {
  const [draft, setDraft] = useState<Draft>(blank);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [opened, setOpened] = useState(open);
  // Each opening starts from an empty proposal.
  if (opened !== open) {
    setOpened(open);
    if (open) {
      setDraft(blank);
      setError('');
    }
  }
  const commit = commits.some((entry) => entry.commit === draft.commit)
    ? draft.commit
    : (commits[0]?.commit ?? '');
  return (
    <Dialog
      open={open}
      title="Propose project memory"
      description="Write down something the factory should know about this project. It waits in the review queue until you approve it."
      onClose={onClose}
      busy={busy}
      dirty={!!draft.content.trim()}
    >
      <form
        className="grid gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (busy || !connected || !commit || !draft.content.trim()) return;
          setBusy(true);
          setError('');
          void api
            .createMemory({
              project_id: projectId,
              kind: draft.kind,
              content: draft.content.trim(),
              source_commit: commit,
              scope: draft.scope,
              citations: citationList(draft.citations),
            })
            .then(onProposed)
            .catch((reason: unknown) => setError(message(reason)))
            .finally(() => setBusy(false));
        }}
      >
        {!commits.length && (
          <Notice tone="warning" role="status">
            Read the repository first. A memory is anchored to a commit the factory has indexed, so its cited
            files can be checked.
          </Notice>
        )}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Type">
            <Select
              value={draft.kind}
              onChange={(event) => setDraft({ ...draft, kind: event.target.value as Draft['kind'] })}
            >
              <option value="lesson">Lesson</option>
              <option value="fact">Fact</option>
            </Select>
          </Field>
          <Field label="Scope">
            <Select
              value={draft.scope}
              onChange={(event) => setDraft({ ...draft, scope: event.target.value as Draft['scope'] })}
            >
              <option value="project">Project · carried while cited files hold</option>
              <option value="commit">This commit only</option>
            </Select>
          </Field>
        </div>
        <Field label="Content">
          <Textarea
            required
            rows={5}
            maxLength={8000}
            value={draft.content}
            onChange={(event) => setDraft({ ...draft, content: event.target.value })}
          />
        </Field>
        <Field
          label="Cited files"
          hint="Optional. One repository path per line, optionally with #L<line>. A project memory goes stale when a cited file changes."
        >
          <Textarea
            rows={3}
            className="font-mono text-xs"
            value={draft.citations}
            onChange={(event) => setDraft({ ...draft, citations: event.target.value })}
          />
        </Field>
        <Field
          label="Indexed commit"
          hint="The commit this memory is recorded against. Only commits the factory has indexed are offered."
        >
          <Select
            value={commit}
            disabled={!commits.length}
            onChange={(event) => setDraft({ ...draft, commit: event.target.value })}
          >
            {!commits.length && <option value="">No indexed commit</option>}
            {commits.map((entry, position) => (
              <option key={entry.commit} value={entry.commit}>
                {entry.commit.slice(0, 12)}
                {entry.readAt ? ` · read ${new Date(entry.readAt).toLocaleDateString('en-US')}` : ''}
                {position === 0 ? ' · newest' : ''}
              </option>
            ))}
          </Select>
        </Field>
        {error && (
          <Notice tone="danger" role="alert">
            {error}
          </Notice>
        )}
        <DialogActions>
          <Button variant="secondary" type="button" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={busy || !connected || !commit || !draft.content.trim()}>
            {busy ? 'Saving…' : 'Save proposal'}
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  );
}
