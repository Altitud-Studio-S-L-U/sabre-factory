import { cn } from '../../lib/utils';

/**
 * Static crew portraits: the Supervisor's robot head with one accessory and colour per
 * specialist, so roles read at a glance without relying on colour alone.
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

function Accessory({ role }: { role: CrewRole }) {
  switch (role) {
    case 'pm': // clipboard
      return <path d="M44 40h10v14H44zM46 38h6v4h-6z" />;
    case 'designer': // beret
      return <path d="M14 20c2-8 14-12 24-10s14 6 12 10c-8-3-26-4-36 0zM40 9l3-4 2 1-3 4z" />;
    case 'developer': // headphones
      return <path d="M10 34a22 22 0 0 1 44 0v6h-5v-6a17 17 0 0 0-34 0v6h-5z" />;
    case 'qa': // magnifier
      return <path d="M47 42a6 6 0 1 1-.01 0zM47 45a3 3 0 1 0 .01 0zM51 51l5 5-2 2-5-5z" />;
    case 'devops': // antenna pair
      return <path d="M22 10l3 8h-2l-3-8zM42 10l-3 8h2l3-8zM19 8a2 2 0 1 0 .01 0zM45 8a2 2 0 1 0 .01 0z" />;
    case 'ciso': // shield
      return <path d="M44 38l7 3v6c0 5-3 8-7 10-4-2-7-5-7-10v-6z" />;
    case 'reviewer': // monocle
      return <path d="M40 30a6 6 0 1 1-.01 0zM40 32.5a3.5 3.5 0 1 0 .01 0zM46 36l6 10h-2l-5-9z" />;
    case 'supervisor': // hard hat
      return <path d="M10 24c0-11 10-18 22-18s22 7 22 18zM6 22h52v5H6z" />;
    default: // system: gear dot
      return <path d="M32 8a4 4 0 1 1-.01 0z" />;
  }
}

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
      <rect x="2" y="2" width="60" height="60" rx="14" fill="var(--secondary)" />
      <rect x="14" y="20" width="36" height="32" rx="9" fill={tones[crew]} opacity="0.92" />
      <rect x="18" y="26" width="28" height="13" rx="6" fill="var(--background)" />
      <circle cx="26" cy="32.5" r="2.6" fill={tones[crew]} />
      <circle cx="38" cy="32.5" r="2.6" fill={tones[crew]} />
      <rect x="28" y="44" width="8" height="2.2" rx="1.1" fill="var(--background)" opacity="0.7" />
      <g fill="var(--foreground)" opacity="0.88">
        <Accessory role={crew} />
      </g>
    </svg>
  );
}
