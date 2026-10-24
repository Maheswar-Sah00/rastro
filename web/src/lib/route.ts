export const SECTIONS = ['problem', 'system', 'results', 'map', 'trace', 'ledger'] as const;
export type SectionId = (typeof SECTIONS)[number];

export interface Route { section: SectionId | null; ranch: string | null; shipment: string | null }

export function parseHash(hash: string): Route {
  const h = decodeURIComponent(hash.replace(/^#\/?/, ''));
  const [head, arg] = h.split('/');
  if (head === 'ranch' && arg) return { section: 'map', ranch: arg, shipment: null };
  if (head === 'trace') return { section: 'trace', ranch: null, shipment: arg || null };
  if ((SECTIONS as readonly string[]).includes(head)) return { section: head as SectionId, ranch: null, shipment: null };
  return { section: null, ranch: null, shipment: null };
}

/** Element a route should land on: the shipment detail card for #trace/<id>, else the section. */
export function routeTarget(r: Route): () => HTMLElement | null {
  return () => {
    if (r.section === 'trace' && r.shipment) return document.getElementById('trace-detail') ?? document.getElementById('trace');
    return r.section ? document.getElementById(r.section) : null;
  };
}

let cancelSettle: (() => void) | null = null;

/**
 * Scroll to a target and keep it in place while lazy sections above it load and grow.
 * Re-scrolls on every layout change for `duration` ms, and stops as soon as the
 * user scrolls, touches, clicks or presses a key.
 */
export function settleScroll(getEl: () => HTMLElement | null, opts: { smooth?: boolean; duration?: number } = {}) {
  cancelSettle?.();
  const duration = opts.duration ?? 3500;
  let stopped = false;
  let raf = 0;
  const go = (smooth: boolean) => {
    const el = getEl();
    if (el) el.scrollIntoView({ behavior: smooth ? 'smooth' : 'auto', block: 'start' });
  };
  go(!!opts.smooth);
  const onLayout = () => {
    if (stopped) return;
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => go(false));
  };
  const ro = 'ResizeObserver' in window ? new ResizeObserver(onLayout) : null;
  ro?.observe(document.body);
  const main = document.querySelector('main');
  if (main) ro?.observe(main);
  const stop = () => {
    if (stopped) return;
    stopped = true;
    cancelAnimationFrame(raf);
    ro?.disconnect();
    window.clearTimeout(timer);
    for (const ev of USER_EVENTS) window.removeEventListener(ev, stop, true);
    if (cancelSettle === stop) cancelSettle = null;
  };
  const USER_EVENTS = ['wheel', 'touchstart', 'keydown', 'mousedown'] as const;
  for (const ev of USER_EVENTS) window.addEventListener(ev, stop, { capture: true, passive: true });
  const timer = window.setTimeout(stop, duration);
  cancelSettle = stop;
  return stop;
}

export function scrollToSection(id: string, smooth = true) {
  settleScroll(() => document.getElementById(id), { smooth, duration: 2500 });
}
