import { useSyncExternalStore } from 'react';
import { flushSync } from 'react-dom';

// Light / dark theme. Dark is the default; the viewer's choice is remembered per browser.
// index.html applies the stored value before first paint, so there is no flash.

export type Theme = 'dark' | 'light';
const KEY = 'rastro-theme';
const listeners = new Set<() => void>();

function read(): Theme {
  const t = typeof document !== 'undefined' ? document.documentElement.dataset.theme : undefined;
  return t === 'light' ? 'light' : 'dark';
}

export function setTheme(t: Theme) {
  document.documentElement.dataset.theme = t;
  try {
    localStorage.setItem(KEY, t);
  } catch {
    /* storage blocked: the choice lasts for this page view */
  }
  listeners.forEach((l) => l());
}

/**
 * Switch theme with a circular reveal growing from (x, y), e.g. the toggle button.
 * Uses the View Transitions API; falls back to an instant switch.
 */
export function switchTheme(t: Theme, x: number, y: number) {
  const doc = document as Document & { startViewTransition?: (cb: () => void) => { ready: Promise<void> } };
  if (!doc.startViewTransition || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return setTheme(t);
  const r = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y));
  const vt = doc.startViewTransition(() => flushSync(() => setTheme(t)));
  void vt.ready.then(() => {
    document.documentElement.animate(
      { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${r}px at ${x}px ${y}px)`] },
      { duration: 700, easing: 'cubic-bezier(0.4, 0, 0.2, 1)', pseudoElement: '::view-transition-new(root)' },
    );
  });
}

export function useTheme(): [Theme, (t: Theme) => void] {
  const t = useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    read,
    () => 'dark' as Theme,
  );
  return [t, setTheme];
}
