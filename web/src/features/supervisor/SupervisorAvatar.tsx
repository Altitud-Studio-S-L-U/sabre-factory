import { useId } from 'react';
import { presenceLabels, type Presence } from './presence';
import './SupervisorAvatar.css';

/**
 * Eye shapes per state, so each state reads without colour or motion: open capsules at rest,
 * lowered when listening, scanning bars while working, a glance aside while a tool runs,
 * wide circles when the owner is needed, smiling arcs after a reply, crosses when blocked and
 * flat lines when offline.
 */
function Eyes({ presence }: { presence: Presence }) {
  switch (presence) {
    case 'offline':
      return (
        <g className="orb-eyes" fill="none" strokeWidth="2.6" strokeLinecap="round">
          <path d="M22.5 33h6M35.5 33h6" />
        </g>
      );
    case 'blocked':
      return (
        <g className="orb-eyes" fill="none" strokeWidth="2.4" strokeLinecap="round">
          <path d="M23 30l5 5M28 30l-5 5M36 30l5 5M41 30l-5 5" />
        </g>
      );
    case 'done':
      return (
        <g className="orb-eyes" fill="none" strokeWidth="2.6" strokeLinecap="round">
          <path d="M22.5 34q3-4 6 0M35.5 34q3-4 6 0" />
        </g>
      );
    case 'working':
    case 'queued':
      return (
        <g className="orb-eyes orb-eyes-scan">
          <rect x="22" y="31" width="7" height="3.6" rx="1.8" />
          <rect x="35" y="31" width="7" height="3.6" rx="1.8" />
        </g>
      );
    case 'using-tool':
      return (
        <g className="orb-eyes orb-eyes-aside">
          <rect x="25" y="29.5" width="4.4" height="6.5" rx="2.2" />
          <rect x="38" y="29.5" width="4.4" height="6.5" rx="2.2" />
        </g>
      );
    case 'needs-you':
      return (
        <g className="orb-eyes">
          <circle cx="25.5" cy="32.5" r="3.4" />
          <circle cx="38.5" cy="32.5" r="3.4" />
        </g>
      );
    case 'listening':
      return (
        <g className="orb-eyes orb-eyes-down">
          <rect x="23" y="31.5" width="5" height="5" rx="2.5" />
          <rect x="36" y="31.5" width="5" height="5" rx="2.5" />
        </g>
      );
    default:
      return (
        <g className="orb-eyes orb-eyes-blink">
          <rect x="23" y="28.5" width="5" height="8" rx="2.5" />
          <rect x="36" y="28.5" width="5" height="8" rx="2.5" />
        </g>
      );
  }
}

/**
 * The Supervisor: a glowing orb with a calm face, in the SABRE gold. Motion and colour follow
 * observable state only (see presence.ts); prefers-reduced-motion keeps static poses.
 * Decorative by default; pass `labelled` to expose the state text to assistive technology.
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
  const id = useId().replace(/:/g, '');
  return (
    <span className="supervisor-avatar-root" data-presence={presence} style={{ width: size, height: size }}>
      <svg
        viewBox="0 0 64 64"
        width={size}
        height={size}
        // Inline size wins over container rules such as a button's [&_svg]:size-4.
        style={{ width: size, height: size }}
        role={labelled ? 'img' : undefined}
        aria-label={labelled ? `Supervisor · ${presenceLabels[presence]}` : undefined}
        aria-hidden={labelled ? undefined : true}
        focusable="false"
      >
        <defs>
          <radialGradient id={`${id}-core`} cx="38%" cy="30%" r="75%">
            <stop offset="0%" className="orb-stop-light" />
            <stop offset="55%" className="orb-stop-mid" />
            <stop offset="100%" className="orb-stop-deep" />
          </radialGradient>
          <radialGradient id={`${id}-glow`} cx="50%" cy="50%" r="50%">
            <stop offset="60%" className="orb-glow-inner" />
            <stop offset="100%" className="orb-glow-outer" />
          </radialGradient>
          <linearGradient id={`${id}-sheen`} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="white" stopOpacity="0.55" />
            <stop offset="60%" stopColor="white" stopOpacity="0" />
          </linearGradient>
        </defs>
        <circle className="orb-halo" cx="32" cy="32" r="31" fill={`url(#${id}-glow)`} />
        <g className="orb-body">
          <circle cx="32" cy="32" r="24" fill={`url(#${id}-core)`} />
          {/* Activity ring: still at rest, sweeping while work is observed. */}
          <circle
            className="orb-ring"
            cx="32"
            cy="32"
            r="27.5"
            fill="none"
            strokeWidth="1.6"
            strokeLinecap="round"
          />
          <ellipse
            cx="26"
            cy="20"
            rx="11"
            ry="6.5"
            fill={`url(#${id}-sheen)`}
            transform="rotate(-24 26 20)"
          />
          <rect className="orb-visor" x="17" y="25" width="30" height="15.5" rx="7.75" />
          <Eyes presence={presence} />
          <circle className="orb-satellite" cx="32" cy="4.5" r="2.6" />
        </g>
      </svg>
    </span>
  );
}
