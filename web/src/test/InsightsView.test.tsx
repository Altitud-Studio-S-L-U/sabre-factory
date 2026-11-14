import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import type { Api, Project, RunMetrics } from '../api';
import InsightsView from '../features/insights/InsightsView';
import { runFigures, runMetrics, unmeasuredRunMetrics } from './runMetricsFixture';

const project = { id: 'synthetic-project', name: 'Example project' } as Project;

function show(answer: RunMetrics | (() => Promise<RunMetrics>) = runMetrics()) {
  const runMetricsCall = vi.fn((...filters: [number, string?, string?]) => {
    void filters;
    return typeof answer === 'function' ? answer() : Promise.resolve(answer);
  });
  render(<InsightsView api={{ runMetrics: runMetricsCall } as unknown as Api} projects={[project]} />);
  return runMetricsCall;
}

const tile = (label: string) =>
  within(screen.getByRole('region', { name: 'Summary' }))
    .getByText(label)
    .closest('div')!;

it('summarises the window and names the series beside their totals', async () => {
  show();
  expect(await screen.findByRole('heading', { name: 'Insights', level: 1 })).toBeVisible();
  const summary = await screen.findByRole('region', { name: 'Summary' });
  expect(within(summary).getByText('Runs').closest('div')).toHaveTextContent(
    '74 completed · 1 stopped · 1 cancelled',
  );
  expect(tile('Delivered, of runs that ended')).toHaveTextContent('66.7%1 still open');
  expect(tile('Tokens per completed run')).toHaveTextContent('351KMedian of 4');
  expect(tile('Active time per completed run')).toHaveTextContent('17m 30s');
  expect(tile('API cost')).toHaveTextContent('$3.4214 CLI calls have no price per token');
  expect(tile('Input read from cache')).toHaveTextContent('70%Of 1.8M input tokens');
  expect(tile('Context read again')).toHaveTextContent(
    '3.8%Tool calls that paged back archived text, of 240',
  );
  expect(tile('Measured tokens')).toHaveTextContent('2.2M54 settled calls · 2 never settled');
  // The legend carries the totals of the window until a period is read.
  expect(screen.getByTestId('outcome-period')).toHaveTextContent('Last 30 days');
  const series = screen.getByRole('list', { name: 'Series' });
  expect(
    within(series)
      .getAllByRole('listitem')
      .map((item) => item.textContent),
  ).toEqual(['4Completed', '1Stopped', '1Open', '1Cancelled']);
  expect(screen.getAllByTestId('outcome-column')).toHaveLength(30);
});

it('prints Unknown where nothing was measured and a zero where a zero was measured', async () => {
  show(unmeasuredRunMetrics());
  await screen.findByRole('region', { name: 'Summary' });
  // Nothing completed, no API price and no token split: each of these is unknown, with its reason beside it.
  for (const [label, reason] of [
    ['Tokens per completed run', 'No run completed in this window'],
    ['Active time per completed run', 'No run completed in this window'],
    ['API cost', 'Calls ran through a CLI session, which has no price per token'],
    ['Input read from cache', 'No call reported its token split'],
    ['Context read again', 'No tool call recorded'],
  ]) {
    expect(tile(label)).toHaveTextContent(`Unknown${reason}`);
    expect(tile(label).querySelector('[data-unknown]')).not.toBeNull();
  }
  // One run ended and none was delivered: that is a measured zero.
  expect(tile('Delivered, of runs that ended')).toHaveTextContent('0%1 still open');
  expect(tile('Delivered, of runs that ended').querySelector('[data-unknown]')).toBeNull();
  const tokens = screen.getByRole('heading', { name: 'Tokens' }).closest('section')!;
  expect(within(tokens).getByText('Measured').closest('div')).toHaveTextContent('237,000');
  expect(within(tokens).getByText('Read from the cache').closest('div')).toHaveTextContent('Unknown');
  expect(within(tokens).getByText('Reserved by calls that never settled').closest('div')).toHaveTextContent(
    '0',
  );
  const flows = screen.getByRole('region', { name: 'Figures by flow' });
  expect(within(flows).getByRole('row', { name: /Audit/ })).toHaveTextContent(
    'Audit201UnknownUnknownUnknownUnknown',
  );
});

it('distinguishes a measured zero from an unknown value in the same table', async () => {
  const zero = runFigures({
    runs: 1,
    completed: 1,
    median_tokens_per_completed_run: 0,
    api_cost_usd: 0,
    cache_read_share: 0,
    recovery_ratio: 0,
  });
  show(
    runMetrics({
      totals: zero,
      by_mode: [
        { ...zero, mode: 'patch' },
        { ...runFigures({ runs: 1, stopped: 1 }), mode: 'audit' },
      ],
    }),
  );
  const flows = await screen.findByRole('region', { name: 'Figures by flow' });
  expect(within(flows).getByRole('row', { name: /Patch/ })).toHaveTextContent('Patch1100$0.000%0%');
  expect(within(flows).getByRole('row', { name: /Audit/ })).toHaveTextContent(
    'Audit101UnknownUnknownUnknownUnknown',
  );
});

it('reads one period with the pointer or the arrow keys and offers every value as a table', async () => {
  const user = userEvent.setup();
  show();
  const plot = await screen.findByTestId('outcome-plot');
  const columns = screen.getAllByTestId('outcome-column');
  // 12 November is the third day from the end of the window.
  fireEvent.pointerEnter(columns[27]);
  expect(screen.getByTestId('outcome-period')).toHaveTextContent('Nov 12');
  expect(
    within(screen.getByRole('list', { name: 'Series' }))
      .getAllByRole('listitem')
      .map((item) => item.textContent),
  ).toEqual(['2Completed', '1Stopped', '0Open', '0Cancelled']);
  fireEvent.pointerLeave(plot);
  expect(screen.getByTestId('outcome-period')).toHaveTextContent('Last 30 days');
  await user.tab();
  while (document.activeElement !== plot) await user.tab();
  // Focus starts on the newest period; the arrows walk back and Home jumps to the oldest.
  expect(screen.getByTestId('outcome-period')).toHaveTextContent('Nov 14');
  await user.keyboard('{ArrowLeft}{ArrowLeft}');
  expect(screen.getByTestId('outcome-period')).toHaveTextContent('Nov 12');
  expect(
    screen.getByText('Nov 12: 3 runs created; 2 completed, 1 stopped, 0 open, 0 cancelled.'),
  ).toBeInTheDocument();
  await user.keyboard('{Home}');
  expect(screen.getByTestId('outcome-period')).toHaveTextContent('Oct 16');
  await user.keyboard('{Escape}');
  expect(screen.getByTestId('outcome-period')).toHaveTextContent('Last 30 days');
  const table = screen.getByRole('region', { name: 'Runs by outcome, as a table' });
  expect(within(table).getAllByRole('row')).toHaveLength(31);
  expect(within(table).getByRole('row', { name: /Nov 12/ })).toHaveTextContent('Nov 1232100');
});

it('lists calls that never settled by their failure class and what no class explains', async () => {
  show();
  const calls = (await screen.findByRole('heading', { name: 'Model calls' })).closest('section')!;
  expect(within(calls).getByText('Never settled').closest('div')).toHaveTextContent('2');
  expect(within(calls).getByText('Failed: Rate limit').closest('div')).toHaveTextContent('1');
  expect(within(calls).getByText('No cause recorded').closest('div')).toHaveTextContent('1');
  const specialists = screen.getByRole('list', { name: 'Tokens by specialist' });
  expect(
    within(specialists)
      .getAllByRole('listitem')
      .map((item) => item.textContent),
  ).toEqual([
    'Developer1,200,000 tokens · 24 calls · cache 75%',
    'Analyst700,000 tokens · 20 calls · cache 0%',
    'No specialist recorded250,000 tokens · 12 calls · cache Unknown',
  ]);
});

it('asks again with the chosen window, flow and project and keeps the figures in place meanwhile', async () => {
  const user = userEvent.setup();
  let release: (value: RunMetrics) => void = () => undefined;
  const answers = [Promise.resolve(runMetrics()), new Promise<RunMetrics>((resolve) => (release = resolve))];
  const call = show(() => answers.shift() ?? Promise.resolve(runMetrics()));
  await screen.findByRole('region', { name: 'Summary' });
  expect(call).toHaveBeenLastCalledWith(30, undefined, undefined);
  await user.click(screen.getByRole('button', { name: '90 days' }));
  expect(call).toHaveBeenLastCalledWith(90, undefined, undefined);
  // The earlier figures stay, marked busy, until the new ones arrive.
  const summary = screen.getByRole('region', { name: 'Summary' });
  expect(summary.closest('[aria-busy]')).toHaveAttribute('aria-busy', 'true');
  expect(screen.getByRole('button', { name: 'Refresh' })).toBeDisabled();
  release(runMetrics({ window_days: 90 }));
  await waitFor(() => expect(summary.closest('[aria-busy]')).toHaveAttribute('aria-busy', 'false'));
  // Ninety days are read by week.
  expect(screen.getAllByTestId('outcome-column')).toHaveLength(13);
  await user.selectOptions(screen.getByRole('combobox', { name: 'Flow' }), 'audit');
  await user.selectOptions(screen.getByRole('combobox', { name: 'Project' }), 'synthetic-project');
  await waitFor(() => expect(call).toHaveBeenLastCalledWith(90, 'audit', 'synthetic-project'));
});

it('says so when the window is empty, truncated or could not be read', async () => {
  const empty = runMetrics({
    totals: runFigures(),
    by_mode: [],
    by_specialist: [],
    by_day: [],
    truncated: true,
  });
  const { unmount } = render(
    <InsightsView api={{ runMetrics: () => Promise.resolve(empty) } as unknown as Api} projects={[]} />,
  );
  expect(await screen.findByRole('heading', { name: 'No runs in this window' })).toBeVisible();
  expect(screen.getByText('This window holds more runs than are counted.')).toBeVisible();
  expect(screen.queryByRole('region', { name: 'Summary' })).not.toBeInTheDocument();
  unmount();
  render(
    <InsightsView
      api={{ runMetrics: () => Promise.reject(new Error('The figures could not be read')) } as unknown as Api}
      projects={[]}
    />,
  );
  expect(await screen.findByRole('alert')).toHaveTextContent('The figures could not be read');
  expect(screen.getByRole('button', { name: 'Refresh' })).toBeEnabled();
});
