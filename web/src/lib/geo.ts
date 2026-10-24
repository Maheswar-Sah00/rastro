import type { AreaGeom, Position } from './types';

const rings = (g: AreaGeom): Position[][] => (g.type === 'Polygon' ? [g.coordinates[0]] : g.coordinates.map((p) => p[0]));

export function bboxOfGeom(g: AreaGeom): [number, number, number, number] {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const ring of rings(g)) {
    for (const [x, y] of ring) {
      if (x < x0) x0 = x;
      if (y < y0) y0 = y;
      if (x > x1) x1 = x;
      if (y > y1) y1 = y;
    }
  }
  return [x0, y0, x1, y1];
}

/** Area-weighted centroid of the outer ring(s). */
export function centroidOfGeom(g: AreaGeom): Position {
  let A = 0, cx = 0, cy = 0;
  for (const ring of rings(g)) {
    for (let i = 0; i < ring.length - 1; i++) {
      const [x1, y1] = ring[i];
      const [x2, y2] = ring[i + 1];
      const f = x1 * y2 - x2 * y1;
      A += f;
      cx += (x1 + x2) * f;
      cy += (y1 + y2) * f;
    }
  }
  if (Math.abs(A) < 1e-12) {
    const b = bboxOfGeom(g);
    return [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];
  }
  A /= 2;
  return [cx / (6 * A), cy / (6 * A)];
}

/** Quadratic arc between two points, bending to the right of travel. */
export function arc(a: Position, b: Position, bend = 0.18, n = 28): Position[] {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
  const cx = mx + dy * bend, cy = my - dx * bend;
  const pts: Position[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const u = 1 - t;
    pts.push([u * u * a[0] + 2 * u * t * cx + t * t * b[0], u * u * a[1] + 2 * u * t * cy + t * t * b[1]]);
  }
  return pts;
}

export function unionBbox(...bs: ([number, number, number, number] | null | undefined)[]): [number, number, number, number] | null {
  let out: [number, number, number, number] | null = null;
  for (const b of bs) {
    if (!b) continue;
    out = out ? [Math.min(out[0], b[0]), Math.min(out[1], b[1]), Math.max(out[2], b[2]), Math.max(out[3], b[3])] : [...b];
  }
  return out;
}
