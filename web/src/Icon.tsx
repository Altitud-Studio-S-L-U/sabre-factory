import type { CSSProperties } from 'react';

const paths = {
  work: 'M4 5h16v14H4z M4 9h16 M9 9v10',
  projects: 'M3 7h7l2-3h9v16H3z',
  security: 'M12 3 4 6v5c0 5 8 10 8 10s8-5 8-10V6z M8.5 12l2.5 2.5 4.5-5',
  memory: 'M4 5c0-3 16-3 16 0s-16 3-16 0v14c0 3 16 3 16 0V5 M4 12c0 3 16 3 16 0',
  settings: 'M4 6h16 M4 12h16 M4 18h16 M8 3v6 M16 9v6 M10 15v6',
  refresh: 'M20 8a8 8 0 0 0-14-3L3 8 M3 3v5h5 M4 16a8 8 0 0 0 14 3l3-3 M21 21v-5h-5',
  logout: 'M10 4H4v16h6 M14 8l4 4-4 4 M8 12h12',
  arrow: 'M5 12h14 M13 6l6 6-6 6',
  'chevron-down': 'M6 9l6 6 6-6',
  check: 'M5 12l4 4L19 6',
  alert: 'M12 3 2 21h20z M12 9v5 M12 17v.5',
  empty: 'M4 4h16v16H4z M4 14h5l1 3h4l1-3h5',
  info: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18 M12 11v6 M12 7v.5',
} as const;

export type IconName = keyof typeof paths;

export default function Icon({
  name,
  size = 18,
  style,
}: {
  name: IconName;
  size?: number;
  style?: CSSProperties;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.65"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      style={style}
    >
      <path d={paths[name]} />
    </svg>
  );
}
