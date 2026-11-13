import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { setThemePreference, THEME_KEY, useTheme } from '../lib/theme';

function Toggle() {
  const { preference, resolved, setPreference } = useTheme();
  return (
    <button type="button" onClick={() => setPreference(resolved === 'light' ? 'dark' : 'light')}>
      {preference}:{resolved}
    </button>
  );
}

afterEach(() => {
  act(() => setThemePreference('dark'));
});

it('stores light and removes the stored key for the default dark theme', async () => {
  render(<Toggle />);
  const user = userEvent.setup();
  expect(screen.getByRole('button')).toHaveTextContent('dark:dark');
  await user.click(screen.getByRole('button'));
  expect(screen.getByRole('button')).toHaveTextContent('light:light');
  expect(document.documentElement).toHaveClass('light');
  expect(window.localStorage.getItem(THEME_KEY)).toBe('light');
  await user.click(screen.getByRole('button'));
  expect(document.documentElement).not.toHaveClass('light');
  expect(window.localStorage.getItem(THEME_KEY)).toBeNull();
});

it('follows the system preference only when asked to', () => {
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
  );
  render(<Toggle />);
  expect(document.documentElement).not.toHaveClass('light');
  act(() => setThemePreference('system'));
  expect(screen.getByRole('button')).toHaveTextContent('system:light');
  expect(document.documentElement).toHaveClass('light');
});
