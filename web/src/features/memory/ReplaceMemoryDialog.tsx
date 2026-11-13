import { useState } from 'react';
import type { Api, MemoryListItem } from '../../api';
import Button from '../../components/Button';
import Dialog, { DialogActions } from '../../components/Dialog';
import Field from '../../components/FormField';
import Notice from '../../components/Notice';
import Select from '../../components/Select';
import Textarea from '../../components/Textarea';
import { message } from '../runs/shared';

type Draft = { kind: 'fact' | 'lesson'; scope: 'commit' | 'project'; content: string; citations: string };

const draftOf = (item: MemoryListItem): Draft => ({
  kind: item.kind,
  scope: item.scope ?? 'commit',
  content: item.content,
  citations: item.citations.join('\n'),
});
const citationList = (value: string) => [
  ...new Set(
    value
      .split(/[\n,]/)
      .map((line) => line.trim())
      .filter(Boolean),
  ),
];

/**
 * Memories are immutable: an edit is a new proposal with the same provenance that supersedes the
 * original. Approving it in the review queue invalidates the original in the same transaction.
 */
export default function ReplaceMemoryDialog({
  api,
  item,
  open,
  connected,
  onClose,
  onProposed,
}: {
  api: Api;
  item: MemoryListItem;
  open: boolean;
  connected: boolean;
  onClose: () => void;
  onProposed: (id: string) => void;
}) {
  const [draft, setDraft] = useState<Draft>(() => draftOf(item));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [opened, setOpened] = useState(open);
  // Each opening starts again from the memory as it is.
  if (opened !== open) {
    setOpened(open);
    if (open) {
      setDraft(draftOf(item));
      setError('');
    }
  }
  const original = draftOf(item);
  const citations = citationList(draft.citations);
  const unchanged =
    draft.kind === original.kind &&
    draft.scope === original.scope &&
    draft.content.trim() === original.content.trim() &&
    citations.join('\n') === citationList(original.citations).join('\n');
  return (
    <Dialog
      open={open}
      title="Propose a replacement"
      description="Your edit becomes a new proposal with this memory’s provenance. Approving it replaces the original."
      onClose={onClose}
      busy={busy}
      dirty={!unchanged}
    >
      <form
        className="grid gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (busy || !connected || unchanged) return;
          setBusy(true);
          setError('');
          void api
            .createMemory({
              project_id: item.project_id,
              kind: draft.kind,
              content: draft.content.trim(),
              source_commit: item.source_commit,
              source_work_id: item.source_work_id,
              evidence_digest: item.evidence_digest ?? null,
              scope: draft.scope,
              citations,
              supersedes: item.id,
            })
            .then((created) => onProposed(created.id))
            .catch((reason: unknown) => setError(message(reason)))
            .finally(() => setBusy(false));
        }}
      >
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
            rows={8}
            maxLength={8000}
            value={draft.content}
            onChange={(event) => setDraft({ ...draft, content: event.target.value })}
          />
        </Field>
        <Field
          label="Cited files"
          hint={`One repository path per line, optionally with #L<line>. Checked against the index at ${item.source_commit.slice(0, 12)}; a project memory goes stale when a cited file changes.`}
        >
          <Textarea
            rows={3}
            className="font-mono text-xs"
            value={draft.citations}
            onChange={(event) => setDraft({ ...draft, citations: event.target.value })}
          />
        </Field>
        <p className="text-xs text-muted-foreground">
          Provenance stays the original’s: run <code className="font-mono">{item.source_work_id}</code> at
          commit <code className="font-mono">{item.source_commit.slice(0, 12)}</code>.
        </p>
        {error && (
          <Notice tone="danger" role="alert">
            {error}
          </Notice>
        )}
        <DialogActions>
          <Button variant="secondary" type="button" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={busy || !connected || unchanged || !draft.content.trim()}>
            {busy ? 'Proposing…' : 'Propose replacement'}
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  );
}
