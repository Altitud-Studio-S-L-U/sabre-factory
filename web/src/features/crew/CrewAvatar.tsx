import { cn } from '../../lib/utils';

/**
 * Crew marks for the specialists: one colour and initials per role, so roles read at a glance
 * without relying on colour alone.
 */
export type CrewRole =
  | 'pm'
  | 'designer'
  | 'developer'
  | 'qa'
  | 'devops'
  | 'ciso'
  | 'supervisor'
  | 'system'
  | 'reviewer';

const roleAliases: Record<string, CrewRole> = {
  analyst: 'pm',
  pm: 'pm',
  designer: 'designer',
  design: 'designer',
  architect: 'developer',
  developer: 'developer',
  qa: 'qa',
  verification: 'qa',
  devops: 'devops',
  delivery: 'devops',
  security: 'ciso',
  ciso: 'ciso',
  supervisor: 'supervisor',
  reviewer: 'reviewer',
  system: 'system',
};

const roleLabels: Record<CrewRole, string> = {
  pm: 'PM',
  designer: 'Designer',
  developer: 'Developer',
  qa: 'QA',
  devops: 'DevOps',
  ciso: 'CISO',
  supervisor: 'Supervisor',
  system: 'System',
  reviewer: 'Reviewer',
};

/** Fill colour per role, from the timeline and state tokens. */
const tones: Record<CrewRole, string> = {
  pm: 'var(--timeline-memory)',
  designer: 'oklch(0.76 0.12 350)',
  developer: 'var(--timeline-agent)',
  qa: 'var(--success)',
  devops: 'var(--timeline-tool)',
  ciso: 'var(--timeline-failure)',
  supervisor: 'var(--primary)',
  system: 'var(--neutral)',
  reviewer: 'var(--info)',
};

export function crewRole(value: string | null | undefined): CrewRole {
  const key = String(value ?? '')
    .toLowerCase()
    .split(/[\s·_-]+/)[0];
  return roleAliases[key] ?? 'system';
}

const initials: Record<CrewRole, string> = {
  pm: 'PM',
  designer: 'DS',
  developer: 'DV',
  qa: 'QA',
  devops: 'DO',
  ciso: 'CS',
  supervisor: 'SV',
  system: '',
  reviewer: 'RV',
};

export function crewLabel(value: string | null | undefined): string {
  return roleLabels[crewRole(value)];
}

export function crewTone(value: string | null | undefined): string {
  return tones[crewRole(value)];
}

/**
 * Crew mark: a ring in the role colour around the role initials, from the same family as the
 * Supervisor orb. Below 22 px only the ring remains; callers show the role name beside it there.
 */
export default function CrewAvatar({
  role,
  size = 28,
  labelled = false,
  className,
}: {
  role: string | null | undefined;
  size?: number;
  labelled?: boolean;
  className?: string;
}) {
  const crew = crewRole(role);
  const tone = tones[crew];
  const text = size >= 22 ? initials[crew] : '';
  return (
    <svg
      viewBox="0 0 64 64"
      width={size}
      height={size}
      style={{ width: size, height: size }}
      className={cn('shrink-0', className)}
      role={labelled ? 'img' : undefined}
      aria-label={labelled ? roleLabels[crew] : undefined}
      aria-hidden={labelled ? undefined : true}
      focusable="false"
      data-crew={crew}
    >
      <circle cx="32" cy="32" r="29" fill="var(--card)" />
      <circle cx="32" cy="32" r="29" fill={tone} opacity="0.14" />
      <circle cx="32" cy="32" r="27" fill="none" stroke={tone} strokeWidth="4.5" />
      {crew === 'system' ? (
        <g fill="none" stroke={tone} strokeWidth="4" strokeLinecap="round">
          <circle cx="32" cy="32" r="7" />
          <path d="M32 15v6M32 43v6M15 32h6M43 32h6" />
        </g>
      ) : text ? (
        <text
          x="32"
          y="33"
          textAnchor="middle"
          dominantBaseline="central"
          fill={tone}
          fontFamily="inherit"
          fontWeight="700"
          fontSize={text.length > 1 ? 21 : 26}
          letterSpacing="0.5"
        >
          {text}
        </text>
      ) : (
        <circle cx="32" cy="32" r="11" fill={tone} />
      )}
    </svg>
  );
}
