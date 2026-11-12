import { presenceLabels, type Presence } from './presence';
import './SupervisorAvatar.css';

/** Eye shapes per state, so the state reads without colour or motion. */
function Eyes({ presence }: { presence: Presence }) {
  switch (presence) {
    case 'offline':
      return (
        <g className="avatar-eyes" strokeWidth="2.4" strokeLinecap="round">
          <path d="M21 33h6M37 33h6" />
        </g>
      );
    case 'blocked':
      return (
        <g className="avatar-eyes" strokeWidth="2.4" strokeLinecap="round">
          <path d="M21 30l6 6M27 30l-6 6M37 30l6 6M43 30l-6 6" />
        </g>
      );
    case 'done':
      return (
        <g className="avatar-eyes" strokeWidth="2.6" strokeLinecap="round" fill="none">
          <path d="M20 35q4-5 8 0M36 35q4-5 8 0" />
        </g>
      );
    case 'working':
    case 'queued':
      return (
        <g className="avatar-eyes avatar-eyes-scan">
          <rect x="19" y="31" width="10" height="4" rx="2" />
          <rect x="35" y="31" width="10" height="4" rx="2" />
        </g>
      );
    case 'needs-you':
      return (
        <g className="avatar-eyes">
          <circle cx="24" cy="33" r="4" />
          <circle cx="40" cy="33" r="4" />
        </g>
      );
    case 'listening':
      return (
        <g className="avatar-eyes avatar-eyes-down">
          <circle cx="25" cy="34" r="3.2" />
          <circle cx="41" cy="34" r="3.2" />
        </g>
      );
    default:
      return (
        <g className="avatar-eyes avatar-eyes-blink">
          <circle cx="24" cy="33" r="3.2" />
          <circle cx="40" cy="33" r="3.2" />
        </g>
      );
  }
}

/**
 * The Supervisor: a robot foreman in a SABRE hard hat. Decorative by default; pass
 * `labelled` to expose the state text to assistive technology.
 */
export default function SupervisorAvatar({
  presence,
  size = 40,
  labelled = false,
}: {
  presence: Presence;
  size?: number;
  labelled?: boolean;
}) {
  return (
    <span className="supervisor-avatar-root" data-presence={presence} style={{ width: size, height: size }}>
      <svg
        viewBox="0 0 64 64"
        width={size}
        height={size}
        role={labelled ? 'img' : undefined}
        aria-label={labelled ? `Supervisor · ${presenceLabels[presence]}` : undefined}
        aria-hidden={labelled ? undefined : true}
        focusable="false"
      >
        {/* Head and visor */}
        <rect className="avatar-head" x="12" y="20" width="40" height="34" rx="10" />
        <rect className="avatar-visor" x="16" y="26" width="32" height="15" rx="7" />
        <Eyes presence={presence} />
        <rect className="avatar-mouth" x="27" y="46" width="10" height="2.4" rx="1.2" />
        {/* Hard hat with the three SABRE bars and a status lamp */}
        <path className="avatar-hat" d="M10 24c0-11 10-18 22-18s22 7 22 18z" />
        <rect className="avatar-brim" x="6" y="22" width="52" height="5" rx="2.5" />
        <g className="avatar-bars">
          <path d="M23 10h3.4l-3.4 11h-3.4z" />
          <path d="M30.3 10h3.4l-3.4 11h-3.4z" />
          <path d="M37.6 10h3.4l-3.4 11h-3.4z" />
        </g>
        <circle className="avatar-lamp" cx="32" cy="5" r="3.2" />
      </svg>
    </span>
  );
}
