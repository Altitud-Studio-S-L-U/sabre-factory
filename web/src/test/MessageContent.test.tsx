import { render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import MessageContent from '../components/MessageContent';

it('renders structured budget replies without activating model-provided HTML or images', () => {
  const { container } = render(
    <MessageContent
      text={
        '**Budget**\n\n| Metric | Used |\n| --- | --- |\n| Tokens | 1200 |\n\n`get_work_budget`\n\n<img src="https://example.test/leak">\n\n![remote](https://example.test/image)\n\n[unsafe](javascript:alert%281%29)'
      }
    />,
  );
  expect(screen.getByRole('columnheader', { name: 'Metric' })).toBeInTheDocument();
  expect(screen.getByRole('cell', { name: '1200' })).toBeInTheDocument();
  expect(container.querySelector('strong')).toHaveTextContent('Budget');
  expect(container.querySelector('img')).toBeNull();
  expect(container.querySelector('a')).not.toHaveAttribute('href', expect.stringContaining('javascript:'));
});
