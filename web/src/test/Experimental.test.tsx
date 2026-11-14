import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import Experimental from '../components/Experimental';
import { SectionHeading } from '../components/PageHeader';

it('labels an unproven surface beside its heading and leaves the heading its own name', () => {
  render(<SectionHeading title="External tasks" badge={<Experimental />} />);
  // The label sits outside the heading: links, tests and assistive technology still find it by its title.
  expect(screen.getByRole('heading', { name: 'External tasks' })).toBeVisible();
  const label = screen.getByText('Experimental', { exact: false });
  expect(label).toHaveAttribute('title', expect.stringMatching(/has not been proven with a real run/));
  // The reason is text for a screen reader too, not only a hover hint.
  expect(label).toHaveTextContent(/^Experimental: It passes its tests against synthetic services/);
});

it('says why when a surface has its own reason', () => {
  render(<Experimental reason="It has not been connected to github.com yet." />);
  expect(screen.getByText(/^Experimental/)).toHaveTextContent(
    'Experimental: It has not been connected to github.com yet.',
  );
});

it.each([
  ['RemoteAgentsPanel.tsx', 'outbound A2A agents'],
  ['InboundAccessPanel.tsx', 'inbound delegated access'],
  ['RemoteTasksPanel.tsx', 'external task receipts'],
  ['ReleasesPanel.tsx', 'release candidates'],
  ['BrowserReportsPanel.tsx', 'browser verification'],
  ['CreateRepositoryFlow.tsx', 'the create flow'],
  ['ToolsConsole.tsx', 'the Slack channel'],
  ['features/tools/GitHubConnection.tsx', 'the GitHub connection'],
])('%s keeps the label on %s', (file) => {
  // These surfaces have no evidence from real use yet. Removing the label is a decision, not a refactor.
  const source = readFileSync(resolve(process.cwd(), 'src', file), 'utf8');
  expect(source).toMatch(/<Experimental\b/);
});
