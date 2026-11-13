import { useSyncExternalStore } from 'react';

/** The lg breakpoint: sidebar navigation and a header with room for global actions. */
export const WIDE_SCREEN = '(min-width: 64rem)';

/** Whether a media query matches now. False where matchMedia is unavailable (tests, old engines). */
export function useMediaQuery(query: string) {
  return useSyncExternalStore(
    (onChange) => {
      if (typeof window.matchMedia !== 'function') return () => undefined;
      const list = window.matchMedia(query);
      list.addEventListener('change', onChange);
      return () => list.removeEventListener('change', onChange);
    },
    () => typeof window.matchMedia === 'function' && window.matchMedia(query).matches,
    () => false,
  );
}
