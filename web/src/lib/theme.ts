import { useCallback, useEffect, useSyncExternalStore } from 'react';

/**
 * Colour theme. Dark is SABRE's identity and the default; light and "follow the system" are
 * opt-in per browser. index.html applies the stored choice before the first paint with the
 * same key and rule, so keep both in step.
 */
export type ThemePreference = 'dark' | 'light' | 'system';

export const THEME_KEY = 'sabre.theme';
const LIGHT_QUERY = '(prefers-color-scheme: light)';
const listeners = new Set<() => void>();

function stored(): ThemePreference {
  try {
    const value = window.localStorage.getItem(THEME_KEY);
    return value === 'light' || value === 'system' ? value : 'dark';
  } catch {
    return 'dark';
  }
}

let preference: ThemePreference = typeof window === 'undefined' ? 'dark' : stored();

function systemPrefersLight() {
  return typeof window.matchMedia === 'function' && window.matchMedia(LIGHT_QUERY).matches;
}

export function resolveTheme(value: ThemePreference): 'dark' | 'light' {
  return value === 'system' ? (systemPrefersLight() ? 'light' : 'dark') : value;
}

function apply() {
  const light = resolveTheme(preference) === 'light';
  document.documentElement.classList.toggle('light', light);
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', light ? '#f7f8fa' : '#171c27');
}

export function setThemePreference(value: ThemePreference) {
  preference = value;
  try {
    if (value === 'dark') window.localStorage.removeItem(THEME_KEY);
    else window.localStorage.setItem(THEME_KEY, value);
  } catch {
    // A blocked store keeps the choice for this tab only.
  }
  apply();
  for (const listener of listeners) listener();
}

/** The stored preference and the theme it resolves to now, following system changes. */
export function useTheme() {
  // The snapshot carries the resolved theme too, so a system change re-renders subscribers.
  const snapshot = useSyncExternalStore(
    (onChange) => {
      listeners.add(onChange);
      return () => listeners.delete(onChange);
    },
    () => `${preference}:${resolveTheme(preference)}`,
    () => 'dark:dark',
  );
  const [value, resolved] = snapshot.split(':') as [ThemePreference, 'dark' | 'light'];
  useEffect(() => {
    if (value !== 'system' || typeof window.matchMedia !== 'function') return;
    const list = window.matchMedia(LIGHT_QUERY);
    const changed = () => {
      apply();
      for (const listener of listeners) listener();
    };
    list.addEventListener('change', changed);
    return () => list.removeEventListener('change', changed);
  }, [value]);
  const set = useCallback((next: ThemePreference) => setThemePreference(next), []);
  return { preference: value, resolved, setPreference: set };
}
