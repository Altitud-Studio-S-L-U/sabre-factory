import type { MemoryListItem } from '../../api';
import { Badge } from '../../components/ui/badge';

export const channelLabels: Record<string, string> = {
  owner_console: 'You · console',
  owner_mcp: 'You · MCP',
  supervisor_chat: 'Supervisor chat',
  factory: 'Factory',
};

export const validityReasons: Record<string, string> = {
  source_commit: 'Recorded at this commit',
  no_citations: 'Cites no files; carried forward',
  citations_unchanged: 'Cited files unchanged',
  citations_changed: 'Cited files changed since',
  owner: 'Carried forward by you',
  commit_scope: 'Holds for its own commit only',
  not_active: 'Not approved',
  index_missing: 'No repository index for this commit yet',
  not_evaluated: 'Not evaluated yet',
};

export function proposer(value: MemoryListItem['proposed_by'] | null | undefined) {
  if (!value) return 'Unknown (recorded before attribution)';
  const role = value.role ? ` · ${value.role}` : '';
  return `${channelLabels[value.channel] ?? value.channel}${role}`;
}

export function short(id: string) {
  return id.length > 10 ? id.slice(0, 8) : id;
}

export function KindBadge({ kind }: { kind: string }) {
  return (
    <Badge
      variant="outline"
      className={
        kind === 'fact' ? 'border-primary/40 text-primary' : 'border-timeline-memory/50 text-timeline-memory'
      }
    >
      {kind === 'fact' ? 'Fact' : 'Lesson'}
    </Badge>
  );
}

export function StateBadge({ state }: { state: string }) {
  const tone = state === 'active' ? 'success' : state === 'pending' ? 'warning' : 'neutral';
  const label = state === 'active' ? 'Approved' : state === 'pending' ? 'Needs review' : 'Invalidated';
  return <Badge variant={tone}>{label}</Badge>;
}

export function relative(value: string | null | undefined, now = Date.now()) {
  if (!value) return 'Never';
  const minutes = Math.round((now - new Date(value).getTime()) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return new Date(value).toLocaleDateString('en-US', { day: '2-digit', month: 'short' });
}
