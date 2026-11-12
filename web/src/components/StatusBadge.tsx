import { Badge } from './ui/badge';
import Icon, { type IconName } from '../Icon';

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
const stateTones: Record<string, 'neutral' | 'info' | 'warning' | 'danger' | 'success'> = {
  queued: 'neutral',
  cancelled: 'neutral',
  running: 'info',
  waiting_input: 'warning',
  paused: 'warning',
  blocked: 'warning',
  medium: 'warning',
  failed: 'danger',
  high: 'danger',
  critical: 'danger',
  completed: 'success',
  low: 'success',
};

export default function StatusBadge({ value, label }: { value: string; label?: string }) {
  return (
    <Badge variant={stateTones[value] ?? 'neutral'}>
      <Icon name={stateIcons[value] ?? 'info'} size={13} />
      {label ?? value.replaceAll('_', ' ')}
    </Badge>
  );
}
