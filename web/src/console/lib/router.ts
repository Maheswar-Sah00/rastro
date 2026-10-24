import { useEffect, useState } from 'react';

// Hash routes: #/overview, #/map, #/ranches, #/ranches/R0120, #/movements, #/gtas/GTA-…, #/shipments,
// #/shipments/SHP-V-202308, #/lots/LOT-…, #/investigations, #/certificates, #/certificates/0x…,
// #/ledger, #/evaluation, #/sources. Query string after "?" holds filters.
export interface Route { page: string; id: string | null; query: URLSearchParams }

export function parseRoute(hash = window.location.hash): Route {
  const raw = hash.replace(/^#\/?/, '');
  const [path, q = ''] = raw.split('?');
  const [page, ...rest] = path.split('/').filter(Boolean);
  return { page: page || 'overview', id: rest.length ? decodeURIComponent(rest.join('/')) : null, query: new URLSearchParams(q) };
}

export function href(page: string, id?: string | null, query?: Record<string, string | number | undefined | null>) {
  let h = `#/${page}${id ? `/${encodeURIComponent(id)}` : ''}`;
  if (query) {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null && v !== '') p.set(k, String(v));
    const s = p.toString();
    if (s) h += `?${s}`;
  }
  return h;
}

export function navigate(page: string, id?: string | null, query?: Record<string, string | number | undefined | null>) {
  window.location.hash = href(page, id, query);
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parseRoute());
  useEffect(() => {
    const on = () => setRoute(parseRoute());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return route;
}

/** Filters kept in the URL so views are shareable and survive reloads. */
export function setQuery(route: Route, patch: Record<string, string | number | undefined | null>) {
  const q: Record<string, string> = {};
  route.query.forEach((v, k) => (q[k] = v));
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined || v === null || v === '') delete q[k];
    else q[k] = String(v);
  }
  window.location.hash = href(route.page, route.id, q);
}
