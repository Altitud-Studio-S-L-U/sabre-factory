import { useEffect, useState, type KeyboardEvent, type PointerEvent } from 'react';

export const DOCK_MIN = 360;
export const DOCK_MAX = 760;
export const DOCK_DEFAULT = 440;
const STORAGE_KEY = 'sabre.supervisor.dock-width';

export function clampDock(width: number) {
  return Math.round(Math.min(DOCK_MAX, Math.max(DOCK_MIN, width)));
}

function storedWidth() {
  try {
    const value = Number(window.localStorage.getItem(STORAGE_KEY));
    return Number.isFinite(value) && value > 0 ? clampDock(value) : DOCK_DEFAULT;
  } catch {
    return DOCK_DEFAULT;
  }
}

/**
 * Docks the open Supervisor beside the content on wide screens. The page reserves the
 * dock width (html[data-supervisor-dock]), so the panel pushes content instead of covering it.
 */
export function useSupervisorDock(docked: boolean) {
  const [width, setWidth] = useState(storedWidth);
  useEffect(() => {
    const root = document.documentElement;
    if (!docked) {
      delete root.dataset.supervisorDock;
      return;
    }
    root.dataset.supervisorDock = 'true';
    root.style.setProperty('--supervisor-dock-width', `${width}px`);
    try {
      window.localStorage.setItem(STORAGE_KEY, String(width));
    } catch {
      // A blocked store only loses the remembered width.
    }
    return () => {
      delete root.dataset.supervisorDock;
    };
  }, [docked, width]);

  const startResize = (event: PointerEvent<HTMLElement>) => {
    event.preventDefault();
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    const move = (moved: globalThis.PointerEvent) => setWidth(clampDock(window.innerWidth - moved.clientX));
    const stop = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', stop);
      handle.removeEventListener('pointercancel', stop);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', stop);
    handle.addEventListener('pointercancel', stop);
  };

  const resizeWithKeys = (event: KeyboardEvent<HTMLElement>) => {
    const step = event.shiftKey ? 80 : 20;
    const next =
      event.key === 'ArrowLeft'
        ? width + step
        : event.key === 'ArrowRight'
          ? width - step
          : event.key === 'Home'
            ? DOCK_MAX
            : event.key === 'End'
              ? DOCK_MIN
              : null;
    if (next === null) return;
    event.preventDefault();
    setWidth(clampDock(next));
  };

  return { width, startResize, resizeWithKeys };
}
