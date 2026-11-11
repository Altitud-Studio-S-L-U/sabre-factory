import { Badge } from './ui/badge';
import Icon, { type IconName } from '../Icon';
import './StatusBadge.css';

const stateIcons: Record<string, IconName> = {
  queued: 'queued',
  running: 'running',
  completed: 'completed',
  cancelled: 'cancelled',
  failed: 'failed',
  blocked: 'paused',
  paused: 'paused',
  waiting_input: 'alert',
  critical: 'failed',
  high: 'alert',
  medium: 'alert',
  low: 'info',
};
export default function StatusBadge({ value, label }: { value: string; label?: string }) {
  return (
    <Badge variant="outline" className={`badge badge-${value} sabre-status-badge`}>
      <Icon name={stateIcons[value] ?? 'info'} size={13} />
      {label ?? value.replaceAll('_', ' ')}
    </Badge>
  );
}
