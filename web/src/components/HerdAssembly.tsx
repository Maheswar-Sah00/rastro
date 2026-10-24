import { useEffect, useRef, useState } from 'react';
import { useData } from '../lib/data';
import { fmt } from '../lib/format';
import { useTheme, type Theme } from '../lib/theme';
import { BULL_CELLS, BULL_H, BULL_W } from './pixel';

// Scroll-driven scene: scattered cubes (one per head of cattle) assemble into the Rastro mark,
// and the laundered ones light up. Canvas 2D, no dependencies.

interface Cube {
  sx: number; sy: number; sz: number; // scattered position
  ex: number; ey: number; // assembled position (z = 0)
  rx: number; ry: number; rz: number; // scattered rotation
  delay: number;
  tainted: boolean;
}

const FACES: [number[], [number, number, number]][] = [
  [[4, 5, 6, 7], [0, 0, -1]], // front (towards the camera)
  [[1, 0, 3, 2], [0, 0, 1]],
  [[0, 4, 7, 3], [-1, 0, 0]],
  [[5, 1, 2, 6], [1, 0, 0]],
  [[0, 1, 5, 4], [0, -1, 0]],
  [[7, 6, 2, 3], [0, 1, 0]],
];
const CORNERS: [number, number, number][] = [
  [-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1],
  [-1, -1, -1], [1, -1, -1], [1, 1, -1], [-1, 1, -1],
];
const LIGHT = norm([-0.45, -0.75, -0.5]); // towards the light: above, left, in front
type RGB = [number, number, number];
const SCENE: Record<Theme, { ink: RGB; bg: RGB }> = {
  dark: { ink: [206, 214, 207], bg: [12, 15, 13] },
  light: { ink: [30, 40, 34], bg: [245, 245, 240] },
};
const RED: [number, number, number] = [229, 72, 77];

function norm(v: number[]): [number, number, number] {
  const l = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / l, v[1] / l, v[2] / l];
}
function rnd(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}
const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const clamp = (v: number, a = 0, b = 1) => Math.min(b, Math.max(a, v));

function build(sub: number): Cube[] {
  const r = rnd(20201231);
  const cubes: Cube[] = [];
  const gw = BULL_W * sub;
  const gh = BULL_H * sub;
  for (const [cx, cy] of BULL_CELLS) {
    for (let j = 0; j < sub; j++)
      for (let i = 0; i < sub; i++) {
        // Scattered inside a loose ball, a little wider than tall.
        const u = r() * 2 - 1, th = r() * Math.PI * 2, rad = Math.cbrt(r()) * 0.62;
        const k = Math.sqrt(1 - u * u);
        cubes.push({
          sx: k * Math.cos(th) * rad * 1.25,
          sy: u * rad,
          sz: k * Math.sin(th) * rad,
          ex: ((cx * sub + i + 0.5) / gw - 0.5) * (gw / gh),
          ey: (cy * sub + j + 0.5) / gh - 0.5,
          rx: r() * 6.28, ry: r() * 6.28, rz: r() * 6.28,
          delay: r(),
          tainted: false,
        });
      }
  }
  // Roughly one in nine head is laundered, spread through the herd.
  const order = cubes.map((_, i) => i).sort(() => r() - 0.5);
  order.slice(0, Math.round(cubes.length / 9)).forEach((i) => (cubes[i].tainted = true));
  return cubes;
}

function rotate(p: [number, number, number], a: number, b: number, c: number): [number, number, number] {
  let [x, y, z] = p;
  let t = y * Math.cos(a) - z * Math.sin(a); z = y * Math.sin(a) + z * Math.cos(a); y = t;
  t = x * Math.cos(b) + z * Math.sin(b); z = -x * Math.sin(b) + z * Math.cos(b); x = t;
  t = x * Math.cos(c) - y * Math.sin(c); y = x * Math.sin(c) + y * Math.cos(c); x = t;
  return [x, y, z];
}

function draw(ctx: CanvasRenderingContext2D, w: number, h: number, cubes: Cube[], sub: number, p: number, time: number, theme: Theme) {
  const { ink: INK, bg: BG } = SCENE[theme];
  ctx.clearRect(0, 0, w, h);
  const scale = Math.min(w, h * 1.08) * 0.82;
  const cell = 1 / (BULL_H * sub);
  const half = cell * 0.36; // leaves a gap between cubes
  const D = 3.2;
  const spin = time * 0.00012;
  const assembleP = clamp((p - 0.12) / 0.6);
  const glow = clamp((p - 0.74) / 0.16);
  const items: { z: number; polys: { pts: number[]; fill: string }[] }[] = [];

  for (const c of cubes) {
    const t = ease(clamp((assembleP - c.delay * 0.45) / 0.55));
    const free = 1 - t;
    // The scattered cloud turns slowly; the assembled mark faces the viewer.
    const [ox, oy, oz] = rotate([c.sx, c.sy, c.sz], 0.18, spin * 6.28 + p * 1.2, 0);
    const x = ox * free + c.ex * t;
    const y = oy * free + c.ey * t;
    const z = oz * free;
    const a = (c.rx + spin * 9) * free, b = (c.ry + spin * 7) * free, g = c.rz * free;
    const pts = CORNERS.map((k) => {
      const [px, py, pz] = rotate([k[0] * half, k[1] * half, k[2] * half], a, b, g);
      const zz = z + pz + D;
      const f = D / zz;
      return [w / 2 + (x + px) * f * scale, h / 2 + (y + py) * f * scale, zz];
    });
    const base = c.tainted ? mix(INK, RED, glow) : INK;
    const polys: { pts: number[]; fill: string }[] = [];
    for (const [idx, n] of FACES) {
      const nn = rotate(n, a, b, g);
      if (nn[2] > 0.02) continue; // faces pointing away
      const lit = 0.55 + 0.6 * Math.max(0, nn[0] * LIGHT[0] + nn[1] * LIGHT[1] + nn[2] * LIGHT[2]);
      const fade = 0.55 + 0.45 * t; // far cubes in the cloud read lighter
      const col = base.map((v, i) => Math.round(BG[i] + (Math.min(255, v * lit) - BG[i]) * fade));
      polys.push({ pts: idx.flatMap((i) => [pts[i][0], pts[i][1]]), fill: `rgb(${col[0]},${col[1]},${col[2]})` });
    }
    items.push({ z: z + D, polys });
  }
  items.sort((m, n) => n.z - m.z);
  ctx.lineJoin = 'round'; // the fill-coloured stroke rounds every cube corner
  ctx.lineWidth = Math.max(1.5, half * scale * 0.28);
  for (const it of items)
    for (const poly of it.polys) {
      const q = poly.pts;
      ctx.beginPath();
      ctx.moveTo(q[0], q[1]);
      for (let i = 2; i < q.length; i += 2) ctx.lineTo(q[i], q[i + 1]);
      ctx.closePath();
      ctx.fillStyle = poly.fill;
      ctx.strokeStyle = poly.fill;
      ctx.fill();
      ctx.stroke();
    }
}
function mix(a: number[], b: number[], t: number) {
  return a.map((v, i) => v + (b[i] - v) * t);
}

export function HerdAssembly() {
  const metrics = useData('metrics');
  const c = metrics.data?.counts;
  const section = useRef<HTMLElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [stage, setStage] = useState(0);
  const [theme] = useTheme();
  const themeRef = useRef(theme);
  themeRef.current = theme;
  const redraw = useRef<() => void>(() => {});
  useEffect(() => redraw.current(), [theme]);

  useEffect(() => {
    const el = section.current;
    const cv = canvas.current;
    const ctx = cv?.getContext('2d');
    if (!el || !cv || !ctx) return;
    const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let sub = 0, cubes: Cube[] = [], w = 0, h = 0, raf = 0, visible = false, p = still ? 1 : 0;
    const resize = () => {
      const r = cv.getBoundingClientRect();
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      w = r.width;
      h = r.height;
      cv.width = Math.round(w * dpr);
      cv.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const want = w < 560 ? 2 : 3;
      if (want !== sub) {
        sub = want;
        cubes = build(sub);
      }
    };
    const progress = () => {
      const r = el.getBoundingClientRect();
      const span = r.height - window.innerHeight;
      return span > 0 ? clamp(-r.top / span) : 1;
    };
    const frame = (time: number) => {
      if (!still) p = progress();
      setStage(p < 0.36 ? 0 : p < 0.72 ? 1 : 2);
      draw(ctx, w, h, cubes, sub, p, still ? 0 : time, themeRef.current);
      raf = visible && !still ? requestAnimationFrame(frame) : 0;
    };
    resize();
    const io = new IntersectionObserver(([e]) => {
      visible = e.isIntersecting;
      if (visible && !raf) raf = requestAnimationFrame(frame);
    });
    io.observe(el);
    const ro = new ResizeObserver(() => {
      resize();
      if (!raf) frame(performance.now());
    });
    ro.observe(cv);
    frame(0);
    redraw.current = () => !raf && frame(performance.now());
    return () => {
      io.disconnect();
      ro.disconnect();
      cancelAnimationFrame(raf);
    };
  }, []);

  const steps = [
    {
      k: 'Scattered',
      t: `${c ? fmt(c.movements) : '10,844'} movement permits.`,
      d: `Every truckload of cattle across ${c ? fmt(c.ranches) : '409'} ranches over three years. Each permit is filed alone, and nobody joins them up.`,
    },
    {
      k: 'Accounted for',
      t: 'Every head, accounted for.',
      d: 'Rastro balances each ranch like a bank account with biology attached: births, deaths, purchases and sales, lot by lot, first in, first out.',
    },
    {
      k: 'Traced',
      t: 'The laundered ones light up.',
      d: 'Animals born on land cleared after 2020, inside Indigenous territory or under embargo stay visible through every resale, all the way to the ship.',
    },
  ];

  return (
    <section ref={section} className="assembly" aria-label="How Rastro sees the herd">
      <div className="assembly-sticky">
        <div className="wrap assembly-grid">
          <div className="assembly-copy">
            <p className="kicker">One herd, one rulebook</p>
            <ol className="assembly-steps">
              {steps.map((s, i) => (
                <li key={s.k} className={i === stage ? 'on' : i < stage ? 'past' : undefined} aria-current={i === stage ? 'step' : undefined}>
                  <span className="n">0{i + 1}</span>
                  <div>
                    <h3>{s.t}</h3>
                    <p>{s.d}</p>
                  </div>
                </li>
              ))}
            </ol>
          </div>
          <div className="assembly-canvas">
            <canvas ref={canvas} role="img" aria-label="Cubes, one per head of cattle, assemble into the Rastro bull mark; the laundered ones turn red." />
            <p className="assembly-legend" aria-hidden>
              <span>
                <i /> one head
              </span>
              <span className={stage === 2 ? 'on' : undefined}>
                <i className="red" /> born on a flagged ranch
              </span>
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}
