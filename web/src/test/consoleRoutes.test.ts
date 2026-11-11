import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { legacyNavigation, navigation } from '../navigation';

it('serves every console section that the navigation can open on direct load', () => {
  // Vitest runs from web/; the backend list is the one FastAPI uses to serve the SPA entry.
  const file = resolve(process.cwd(), '../backend/src/sabre/console_routes.json');
  const served = (JSON.parse(readFileSync(file, 'utf8')) as { sections: string[] }).sections;
  const sections = [...navigation, ...legacyNavigation].map((item) => item.path.replace(/^\//, ''));
  expect([...served].sort()).toEqual([...sections].sort());
});
