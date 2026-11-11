import type { IconName } from './Icon';

/**
 * Console sections. The backend serves these paths as the SPA entry on direct load from
 * backend/src/sabre/console_routes.json; test/consoleRoutes.test.ts keeps both lists identical.
 */
export type View =
  | 'work'
  | 'projects'
  | 'security'
  | 'memory'
  | 'settings'
  | 'system'
  | 'agents'
  | 'tools'
  | 'config';

export interface NavigationItem {
  id: View;
  path: string;
  label: string;
  icon: IconName;
}

export const navigation: NavigationItem[] = [
  { id: 'work', path: '/work', label: 'Runs', icon: 'work' },
  { id: 'agents', path: '/agents', label: 'Agents', icon: 'projects' },
  { id: 'tools', path: '/tools', label: 'Tools', icon: 'settings' },
  { id: 'memory', path: '/memory', label: 'Memory', icon: 'memory' },
  { id: 'config', path: '/config', label: 'Config', icon: 'settings' },
];

/** Reachable by address but not shown in the sidebar. */
export const legacyNavigation: NavigationItem[] = [
  { id: 'projects', path: '/projects', label: 'Projects', icon: 'projects' },
  { id: 'security', path: '/security', label: 'Security', icon: 'security' },
  { id: 'settings', path: '/integrations', label: 'Integrations', icon: 'settings' },
  { id: 'system', path: '/about', label: 'About', icon: 'info' },
];
