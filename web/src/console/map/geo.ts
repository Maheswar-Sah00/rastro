// Static map layers published by the pipeline into web/public/data/layers/. Served by the console itself.
import type { FeatureCollection, Geometry, Position } from 'geojson';

const BASE = import.meta.env.BASE_URL || './';
const cache = new Map<string, Promise<FeatureCollection>>();

export function loadLayer(name: string): Promise<FeatureCollection> {
  if (!cache.has(name)) {
    cache.set(
      name,
      fetch(`${BASE}data/layers/${name}.geojson`).then((r) => {
        if (!r.ok) throw new Error(`layer ${name}: HTTP ${r.status}`);
        return r.json();
      }),
    );
  }
  return cache.get(name)!;
}

/** Centre of a polygon's bounding box, for drawing route lines between synthetic cells. */
export function centroid(g: Geometry): [number, number] | null {
  const pts: Position[] = [];
  const walk = (c: unknown) => {
    if (Array.isArray(c) && typeof c[0] === 'number') pts.push(c as Position);
    else if (Array.isArray(c)) c.forEach(walk);
  };
  if ('coordinates' in g) walk(g.coordinates);
  if (!pts.length) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of pts) {
    x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
  }
  return [(x0 + x1) / 2, (y0 + y1) / 2];
}

export function bboxOf(g: Geometry): [[number, number], [number, number]] | null {
  const c: Position[] = [];
  const walk = (x: unknown) => {
    if (Array.isArray(x) && typeof x[0] === 'number') c.push(x as Position);
    else if (Array.isArray(x)) x.forEach(walk);
  };
  if ('coordinates' in g) walk(g.coordinates);
  if (!c.length) return null;
  return [
    [Math.min(...c.map((p) => p[0])), Math.min(...c.map((p) => p[1]))],
    [Math.max(...c.map((p) => p[0])), Math.max(...c.map((p) => p[1]))],
  ];
}
