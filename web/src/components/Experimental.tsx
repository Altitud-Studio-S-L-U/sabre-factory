import { Badge } from './ui/badge';

/**
 * Marks a surface that passes its tests against synthetic services and has not been proven by
 * real use. The reason is read by assistive technology and shown on hover; nothing is hidden or
 * disabled by the label.
 */
export default function Experimental({
  reason = 'It passes its tests against synthetic services and has not been proven with a real run.',
}: {
  reason?: string;
}) {
  return (
    <Badge variant="warning" title={reason} data-slot="experimental">
      Experimental
      <span className="sr-only">: {reason}</span>
    </Badge>
  );
}
