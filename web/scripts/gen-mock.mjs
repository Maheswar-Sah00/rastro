// Generates deterministic MOCK data for the Rastro web app (public/data/mock/).
// Every value written here is synthetic, including deforestation and protected
// areas: the real files come from the pipeline (public/data/*).
// Schemas follow docs/SPEC.md section 6.
//
//   node scripts/gen-mock.mjs [seed]

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Delaunay } from 'd3-delaunay';

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(here, '../public/data/mock');

// ---------------------------------------------------------------- helpers
function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
let rnd = Math.random;
const U = (a, b) => a + (b - a) * rnd();
const I = (a, b) => Math.floor(U(a, b + 1));
const chance = (p) => rnd() < p;
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
function weighted(entries) {
  const total = entries.reduce((s, [, w]) => s + w, 0);
  let x = rnd() * total;
  for (const [v, w] of entries) {
    if ((x -= w) <= 0) return v;
  }
  return entries[entries.length - 1][0];
}
const sha = (s) => '0x' + crypto.createHash('sha256').update(String(s)).digest('hex');
const r5 = (v) => Math.round(v * 1e5) / 1e5;
const r1 = (v) => Math.round(v * 10) / 10;
const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

const LAT0 = -6.6;
const MX = 111320 * Math.cos((LAT0 * Math.PI) / 180);
const MY = 110574;
function ringAreaHa(ring) {
  let a = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[i + 1];
    a += x1 * MX * (y2 * MY) - x2 * MX * (y1 * MY);
  }
  return Math.abs(a / 2) / 1e4;
}
function ringCentroid(ring) {
  let a = 0, cx = 0, cy = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[i + 1];
    const f = x1 * y2 - x2 * y1;
    a += f;
    cx += (x1 + x2) * f;
    cy += (y1 + y2) * f;
  }
  a /= 2;
  return [cx / (6 * a), cy / (6 * a)];
}
function inRing([x, y], ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function bboxOf(ring) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of ring) {
    x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
  }
  return [x0, y0, x1, y1];
}
// Irregular "clearing" polygon around (cx, cy) with roughly the target area.
function blob(cx, cy, ha, nv = I(9, 15), irr = 0.32) {
  const rm = Math.sqrt((ha * 1e4) / Math.PI);
  const rx = rm / MX;
  const ry = rm / MY;
  const ph1 = U(0, 6.28), ph2 = U(0, 6.28), stretch = U(0.65, 1.35), rot = U(0, 3.14);
  const ring = [];
  for (let k = 0; k < nv; k++) {
    const t = (k / nv) * Math.PI * 2;
    const f = 1 + irr * (0.6 * Math.sin(2 * t + ph1) + 0.4 * Math.sin(3 * t + ph2)) + U(-irr, irr) * 0.5;
    let x = Math.cos(t) * f * stretch;
    let y = Math.sin(t) * f / stretch;
    const xr = x * Math.cos(rot) - y * Math.sin(rot);
    const yr = x * Math.sin(rot) + y * Math.cos(rot);
    ring.push([r5(cx + xr * rx), r5(cy + yr * ry)]);
  }
  ring.push(ring[0]);
  return ring;
}
function randomPointIn(ring, avoid) {
  const [x0, y0, x1, y1] = bboxOf(ring);
  for (let k = 0; k < 400; k++) {
    const p = [U(x0, x1), U(y0, y1)];
    if (inRing(p, ring) && !(avoid && avoid(p))) return p;
  }
  return ringCentroid(ring);
}

const D0 = Date.UTC(2023, 0, 1);
const dayToIso = (d) => new Date(D0 + d * 86400000).toISOString().slice(0, 10);
const isoToDay = (s) => Math.round((Date.parse(s + 'T00:00:00Z') - D0) / 86400000);
const END = isoToDay('2025-12-31');
const yearStart = (y) => isoToDay(`${y}-01-01`);

// ---------------------------------------------------------------- static geography
const AOI = [-52.4, -6.9, -51.8, -6.3];
const WIN = [-52.3, -6.84, -51.86, -6.4];

const DESTINATIONS = [
  { id: 'S:SIF_MOCK01', kind: 'slaughterhouse', name: 'Slaughterhouse A (SIF, Tucumã)', company: 'Anonymised', inspection: 'SIF', lat: -6.749, lon: -51.162, municipality: 'Tucumã', real: false },
  { id: 'S:SIF_MOCK02', kind: 'slaughterhouse', name: 'Slaughterhouse B (SIF, Xinguara)', company: 'Anonymised', inspection: 'SIF', lat: -7.095, lon: -49.946, municipality: 'Xinguara', real: false },
  { id: 'S:SIE_MOCK03', kind: 'slaughterhouse', name: 'Slaughterhouse C (SIE, São Félix do Xingu)', company: 'Anonymised', inspection: 'SIE', lat: -6.648, lon: -51.985, municipality: 'São Félix do Xingu', real: false },
  { id: 'S:SIF_MOCK04', kind: 'slaughterhouse', name: 'Slaughterhouse D (SIF, Redenção)', company: 'Anonymised', inspection: 'SIF', lat: -8.029, lon: -50.031, municipality: 'Redenção', real: false },
  { id: 'P:BARCARENA', kind: 'port', name: 'Port of Vila do Conde (live-cattle export)', company: null, inspection: null, lat: -1.546, lon: -48.752, municipality: 'Barcarena', real: true },
];
const SLAUGHTER = DESTINATIONS.filter((d) => d.kind === 'slaughterhouse').map((d) => d.id);
const PORT = 'P:BARCARENA';

function build(seed) {
  rnd = mulberry32(seed);

  // Protected area (illustrative outline only).
  const paRing = (() => {
    const cx = -51.925, cy = -6.53, rx = 0.105, ry = 0.13, nv = 56;
    const ph1 = U(0, 6.28), ph2 = U(0, 6.28);
    const ring = [];
    for (let k = 0; k < nv; k++) {
      const t = (k / nv) * Math.PI * 2;
      const f = 1 + 0.12 * Math.sin(3 * t + ph1) + 0.07 * Math.sin(7 * t + ph2) + U(-0.025, 0.025);
      ring.push([r5(cx + Math.cos(t) * rx * f), r5(cy + Math.sin(t) * ry * f)]);
    }
    ring.push(ring[0]);
    return ring;
  })();
  const PA_NAME = 'Indigenous land (mock outline)';
  const inPA = (p) => inRing(p, paRing);

  // Ranch seeds: best-candidate sampling for an even, organic spread.
  const seeds = [];
  while (seeds.length < 52) {
    let best = null, bestD = -1;
    for (let c = 0; c < 18; c++) {
      const p = [U(WIN[0], WIN[2]), U(WIN[1], WIN[3])];
      let d = Infinity;
      for (const s of seeds) d = Math.min(d, ((s[0] - p[0]) * 1.0) ** 2 + ((s[1] - p[1]) * 1.25) ** 2);
      if (d > bestD) { bestD = d; best = p; }
    }
    seeds.push(best);
  }
  const vor = Delaunay.from(seeds).voronoi(WIN);
  let cells = seeds.map((s, i) => {
    const poly = vor.cellPolygon(i);
    const ring = poly.map(([x, y]) => [r5(x), r5(y)]);
    const c = ringCentroid(ring);
    return { ring, c, area: ringAreaHa(ring), inPA: inPA(c) };
  });
  // Keep at most 3 ranches inside the protected area (illegal pasture), drop the rest.
  const paCells = cells.filter((c) => c.inPA).sort((a, b) => b.c[0] - a.c[0]);
  const keepPA = new Set(paCells.slice(-3));
  cells = cells.filter((c) => !c.inPA || keepPA.has(c));
  // Thin to 40 ranches; the holes read as remaining forest.
  while (cells.length > 40) {
    const cands = cells.filter((c) => !c.inPA);
    const victim = pick(cands);
    cells = cells.filter((c) => c !== victim);
  }
  cells.sort((a, b) => {
    const ra = Math.floor((a.c[1] - WIN[3]) / -0.09), rb = Math.floor((b.c[1] - WIN[3]) / -0.09);
    return ra - rb || a.c[0] - b.c[0];
  });

  // ---------------------------------------------------------------- ranch roles + ground truth
  const ranches = cells.map((c, i) => ({
    id: 'R' + String(i + 1).padStart(4, '0'),
    ring: c.ring, c: c.c, area_ha: c.area, in_protected: c.inPA,
    role: null, truth: 'honest', tags: new Set(),
    defor: [], // {year, ha}
  }));
  const byId = new Map(ranches.map((r) => [r.id, r]));
  const free = () => ranches.filter((r) => !r.role);
  const take = (n, role, truth, tag, sorter) => {
    let pool = free();
    if (sorter) pool.sort(sorter); else pool.sort(() => rnd() - 0.5);
    const out = pool.slice(0, n);
    for (const r of out) { r.role = role; r.truth = truth; if (tag) r.tags.add(tag); }
    return out;
  };
  for (const r of ranches.filter((x) => x.in_protected)) { r.role = 'breeder'; r.truth = 'dirty_source'; r.tags.add('pa'); }
  const east = (a, b) => b.c[0] - a.c[0];
  const embargoed = take(1, 'breeder', 'dirty_source', 'embargo', east)[0];
  take(1, 'breeder', 'dirty_source', 'post2020', east);
  take(1, 'breeder', 'dirty_source', 'post2020', east);
  const hidden = take(1, 'breeder', 'dirty_source', 'hidden')[0]; // clearing below PRODES mapping unit
  const phantoms = take(2, 'breeder', 'phantom_births', 'phantom');
  const launderers = take(3, 'intermediary', 'launderer', 'launder');
  const complicit = take(2, 'fattener', 'over_capacity', 'overcap');
  const quickTrader = take(1, 'intermediary', 'honest', 'quick')[0];
  take(3, 'intermediary', 'honest', 'trader');
  take(6, 'breeder', 'honest');
  take(7, 'rearer', 'honest');
  take(free().length, 'fattener', 'honest');

  const isRole = (role) => ranches.filter((r) => r.role === role);
  const honestBreeders = ranches.filter((r) => r.role === 'breeder' && r.truth === 'honest');
  const rearers = isRole('rearer');
  const honestRearers = rearers.filter((r) => r.truth === 'honest');
  const honestFatteners = ranches.filter((r) => r.role === 'fattener' && r.truth === 'honest');
  const traders = ranches.filter((r) => r.role === 'intermediary' && r.truth === 'honest');
  const dirtySources = ranches.filter((r) => r.truth === 'dirty_source' && !r.tags.has('hidden'));
  // Small post-2020 clearings: EUDR risk ("watch") that may still be legal under Brazilian law.
  for (const pool of [honestBreeders, honestRearers, honestFatteners]) pick(pool).tags.add('smallclear');
  // An honest fattener that leases pasture outside its mapped boundary: a false positive.
  pick(honestFatteners.filter((r) => !r.tags.has('smallclear'))).tags.add('seasonal');

  // ---------------------------------------------------------------- deforestation (mock PRODES)
  const deforFeatures = [];
  const addDefor = (ring, year, ranch) => {
    const ha = ringAreaHa(ring);
    deforFeatures.push({ type: 'Feature', properties: { year, area_ha: r1(ha) }, geometry: { type: 'Polygon', coordinates: [ring] } });
    if (ranch) ranch.defor.push({ year, ha });
  };
  for (const r of ranches) {
    const n = I(1, 4);
    for (let k = 0; k < n; k++) {
      const p = randomPointIn(r.ring, r.in_protected ? null : inPA);
      addDefor(blob(p[0], p[1], U(14, 110)), weighted([[2008, 3], [2009, 2], [2010, 2], [2011, 1], [2012, 1], [2013, 1], [2014, 1], [2015, 1], [2016, 1], [2017, 2], [2018, 2], [2019, 3], [2020, 3]]), r);
    }
    if (r.tags.has('pa') || r.tags.has('post2020') || r.tags.has('embargo')) {
      const m = I(2, 4);
      for (let k = 0; k < m; k++) {
        const p = randomPointIn(r.ring, r.in_protected ? null : inPA);
        addDefor(blob(p[0], p[1], U(22, 130)), I(2021, 2025), r);
      }
    }
    if (r.tags.has('smallclear')) {
      const p = randomPointIn(r.ring, inPA);
      addDefor(blob(p[0], p[1], U(8, 17)), I(2021, 2024), r);
    }
  }
  // Background clearings: frontier outside the ranch window and invasions inside the protected area.
  for (let k = 0; k < 30; k++) {
    let p;
    for (let t = 0; t < 200; t++) {
      p = [U(AOI[0] + 0.01, AOI[2] - 0.01), U(AOI[1] + 0.01, AOI[3] - 0.01)];
      if (!ranches.some((r) => inRing(p, r.ring)) && !inPA(p)) break;
    }
    addDefor(blob(p[0], p[1], U(10, 160)), I(2008, 2025), null);
  }
  for (let k = 0; k < 9; k++) {
    const p = randomPointIn(paRing, (q) => ranches.some((r) => inRing(q, r.ring)));
    addDefor(blob(p[0], p[1], U(12, 90)), I(2021, 2025), null);
  }

  // ---------------------------------------------------------------- herd attributes
  for (const r of ranches) {
    r.defor_post2008_ha = r.defor.reduce((s, d) => s + d.ha, 0);
    r.defor_post2020_ha = r.defor.filter((d) => d.year >= 2021).reduce((s, d) => s + d.ha, 0);
    if (r.tags.has('hidden')) r.hidden_clearing_ha = 4.8; // below the 6.25 ha PRODES mapping unit
    r.pasture_ha = r.area_ha * (r.in_protected ? U(0.3, 0.48) : U(0.5, 0.82));
    r.capacity_head = Math.round(r.pasture_ha * 1.5);
    const occ = r.tags.has('overcap') ? U(1.32, 1.62) : r.tags.has('seasonal') ? U(1.13, 1.18) : r.tags.has('phantom') ? U(0.7, 0.95) : U(0.55, 0.93);
    r.head_now = Math.round(r.capacity_head * occ);
    r.breeding_cows =
      r.role === 'breeder' ? Math.round(r.head_now * (r.tags.has('phantom') ? U(0.14, 0.2) : U(0.38, 0.5))) :
      r.role === 'rearer' ? Math.round(r.head_now * U(0.03, 0.08)) : 0;
    r.births_declared =
      r.tags.has('phantom') ? Math.round(r.breeding_cows * U(1.55, 2.15)) :
      r.role === 'breeder' ? Math.round(r.breeding_cows * U(0.6, 0.8)) :
      r.role === 'rearer' ? Math.round(r.breeding_cows * U(0.5, 0.75)) : 0;
    r.births_biological_max = Math.floor(r.breeding_cows * 0.85);
    r.capacity_peak_pct = Math.round((r.head_now / r.capacity_head) * U(1.02, 1.12) * 100);
    r.onchain_id = sha('ranch:' + r.id);
  }
  embargoed.embargo_since = '2024-08-15';

  // ---------------------------------------------------------------- movements
  const GHOSTS = ['R9001', 'R9002']; // suppliers outside the study window (no boundary on file)
  const moves = [];
  const add = (from, to, head, day, hold = null, rejected = null) => {
    if (day > END || head <= 0) return null;
    // The embargoed ranch cannot move cattle after the embargo: the ledger refuses the permit.
    if (!rejected && from === embargoed.id && dayToIso(day) > embargoed.embargo_since) rejected = 'OriginEmbargoed';
    const m = { from, to, head: Math.max(1, Math.round(head)), day, hold, rejected };
    moves.push(m);
    if (!rejected) onArrive(m);
    return m;
  };
  const after = (m, lo, hi) => m.day + I(lo, hi);
  const survive = (h) => h * U(0.985, 1);
  function onArrive(m) {
    const r = byId.get(m.to);
    if (!r) return;
    const t = r.tags;
    if (r.role === 'rearer') {
      const d = after(m, 150, 300);
      const to = weighted([[pick(honestFatteners), 72], [pick(traders), 18], [pick(launderers), r.truth === 'honest' ? 4 : 30]]);
      add(r.id, to.id, survive(m.head), d, d - m.day);
    } else if (r.role === 'fattener') {
      const d = after(m, 110, 260);
      const to = weighted([[pick(SLAUGHTER), 68], [PORT, 32]]);
      add(r.id, to, survive(m.head), d, d - m.day);
    } else if (r.role === 'intermediary') {
      if (t.has('launder')) {
        const d = after(m, 2, 16);
        const to = weighted([[PORT, 34], [pick(SLAUGHTER), 30], [pick(complicit).id, 36]]);
        add(r.id, to, survive(m.head), d, d - m.day);
      } else {
        const d = t.has('quick') ? after(m, 14, 40) : after(m, 45, 120);
        const to = weighted([[pick(honestFatteners).id, 72], [pick(SLAUGHTER), 28]]);
        add(r.id, to, survive(m.head), d, d - m.day);
      }
    }
  }
  const sellLot = (r, y, frac, buyerFn) => {
    const day = yearStart(y) + I(110, 280);
    const head = Math.min(420, Math.max(30, r.breeding_cows * 0.85 * frac));
    const to = buyerFn();
    add(r.id, typeof to === 'string' ? to : to.id, head, day);
  };
  for (const y of [2023, 2024, 2025]) {
    for (const r of honestBreeders) {
      for (let k = I(2, 3); k > 0; k--) sellLot(r, y, U(0.18, 0.32), () => weighted([[pick(honestRearers), 46], [pick(honestFatteners), 30], [pick(traders), 16], [pick(launderers), 3], [pick(honestBreeders.filter((b) => b !== r)), 5]]));
    }
    for (const r of dirtySources.filter((x) => x.role === 'breeder')) {
      for (let k = I(2, 4); k > 0; k--) {
        const day = yearStart(y) + I(60, 320);
        const head = Math.min(320, Math.max(40, r.breeding_cows * 0.85 * U(0.2, 0.35)));
        const to = weighted([[pick(launderers).id, 74], [pick(complicit).id, 16], [weighted([[PORT, 1], [pick(SLAUGHTER), 1]]), 10]]);
        add(r.id, to, head, day);
      }
    }
    for (const r of phantoms) {
      for (let k = I(4, 6); k > 0; k--) {
        const day = yearStart(y) + I(40, 330);
        const head = Math.min(380, Math.max(60, r.breeding_cows * U(0.35, 0.6)));
        const to = weighted([[pick(launderers).id, 34], [pick(complicit).id, 30], [PORT, 24], [pick(SLAUGHTER), 12]]);
        add(r.id, to, head, day);
      }
    }
    for (const r of [hidden]) {
      for (let k = 2; k > 0; k--) sellLot(r, y, U(0.2, 0.3), () => weighted([[pick(honestFatteners), 60], [pick(traders), 40]]));
    }
    for (const g of GHOSTS) {
      for (let k = 2; k > 0; k--) add(g, weighted([[pick(traders).id, 50], [pick(honestFatteners).id, 50]]), U(40, 160), yearStart(y) + I(30, 330));
    }
  }
  // Seed 2022 stock already on rearers/fatteners so early-2023 sinks have inflow.
  for (const r of [...honestFatteners, ...complicit]) {
    for (let k = I(1, 2); k > 0; k--) {
      const d = I(0, 120);
      add(r.id, weighted([[pick(SLAUGHTER), 68], [PORT, 32]]), U(60, 220), d, null);
    }
  }
  // One launderer tries to ship more than it holds (conservation violation): refused.
  const shortLaunderer = launderers[0];
  const shortDay = isoToDay('2025-04-09');
  add(shortLaunderer.id, PORT, 186, shortDay, 4, 'InsufficientHerd');
  add(launderers[2].id, pick(SLAUGHTER), 132, isoToDay('2024-11-21'), 3, 'InsufficientHerd');
  // The embargoed ranch keeps trying to sell after the embargo date, through a launderer.
  add(embargoed.id, launderers[1].id, 148, isoToDay('2025-03-02'));
  add(embargoed.id, launderers[0].id, 96, isoToDay('2025-07-19'));

  // GTA numbering + hashes.
  moves.sort((a, b) => a.day - b.day || a.from.localeCompare(b.from));
  const seq = { 2022: 0, 2023: 101200, 2024: 118400, 2025: 134900 };
  for (const m of moves) {
    const y = Number(dayToIso(m.day).slice(0, 4));
    seq[y] += I(7, 61);
    m.gta = `GTA-PA-${y}-${String(seq[y]).padStart(6, '0')}`;
    m.hash = sha('gta:' + m.gta);
    m.date = dayToIso(m.day);
    const toR = byId.get(m.to);
    m.purpose = m.to.startsWith('P:') ? 'export' : m.to.startsWith('S:') ? 'slaughter' :
      toR?.role === 'breeder' ? 'breeding' : toR?.role === 'rearer' ? 'rearing' : 'fattening';
  }

  // ---------------------------------------------------------------- per-ranch stats + flags
  const movesTo = new Map(), movesFrom = new Map();
  for (const m of moves) {
    if (m.rejected) continue; // refused by the ledger: never happened on the books
    (movesTo.get(m.to) ?? movesTo.set(m.to, []).get(m.to)).push(m);
    (movesFrom.get(m.from) ?? movesFrom.set(m.from, []).get(m.from)).push(m);
  }
  for (const r of ranches) {
    r.rejected_gtas = moves.filter((m) => m.rejected && m.from === r.id).length;
    const ins = movesTo.get(r.id) ?? [];
    const outs = movesFrom.get(r.id) ?? [];
    r.inflow_head = ins.reduce((s, m) => s + m.head, 0);
    r.outflow_head = outs.reduce((s, m) => s + m.head, 0);
    const holds = outs.filter((m) => m.hold != null).map((m) => m.hold);
    r.median_holding_days = holds.length ? Math.round(median(holds)) : null;
    r.share_fast = holds.length ? holds.filter((h) => h < 45).length / holds.length : 0;
    r.lots_in = ins.length;
    r.lots_out = outs.length;
  }

  const flags = new Map(ranches.map((r) => [r.id, []]));
  const flag = (r, code, severity, title, text, evidence) => flags.get(r.id).push({ code, severity, title, text, evidence });
  const fmt = (n) => Math.round(n).toLocaleString('en-US');
  for (const r of ranches) {
    if (r.defor_post2020_ha >= 6.25) {
      const post = r.defor.filter((d) => d.year >= 2021);
      const yrs = [...new Set(post.map((d) => d.year))].sort();
      const small = r.tags.has('smallclear');
      flag(r, 'POST2020_DEFORESTATION', small ? 'medium' : 'high',
        small ? `${fmt(r.defor_post2020_ha)} ha cleared after the EUDR cut-off (small)` : `${fmt(r.defor_post2020_ha)} ha cleared after the EUDR cut-off`,
        small
          ? `Satellite monitoring mapped one small clearing here in ${yrs.join(', ')}. It may be authorised under Brazilian law, so domestic and Türkiye-bound buyers can accept these animals, but the EU regulation has a zero-deforestation cut-off: they cannot go into an EU-bound lot.`
          : `Satellite monitoring mapped ${post.length} new clearings inside this ranch in ${yrs.join(', ')}. Cattle that spent any time here cannot be sold into the EU after 30 Dec 2026, and clearing at this scale in the region is almost always illegal.`,
        { defor_post2020_ha: r1(r.defor_post2020_ha), polygons: post.length, years: yrs, source: 'PRODES (mock)' });
    }
    if (r.in_protected) {
      flag(r, 'PROTECTED_AREA', 'high', `Pasture inside ${PA_NAME}`,
        'The ranch boundary sits inside a legally protected territory where commercial cattle ranching is not allowed. Every animal born or kept here is tainted.',
        { protected_name: PA_NAME, overlap_ha: r1(r.area_ha * U(0.7, 1)), kind: 'indigenous' });
    }
    if (r === embargoed) {
      flag(r, 'EMBARGOED', 'high', `Under an environmental embargo since ${r.embargo_since}`,
        'The federal environmental agency embargoed this property for illegal clearing. It may not sell cattle, yet it kept requesting permits to move animals to an intermediary. The ledger refused them.',
        { since: r.embargo_since, reason: 'illegal clearing', list: 'Embargo list (mock match)', attempts_after_embargo: moves.filter((m) => m.from === r.id && m.date > r.embargo_since).length, refused_by_ledger: r.rejected_gtas });
    }
    if (r.tags.has('phantom')) {
      const max = Math.floor(r.breeding_cows * 0.85);
      flag(r, 'PHANTOM_BIRTHS', 'high', `Declares ${fmt(r.births_declared)} calves from ${fmt(r.breeding_cows)} cows`,
        `Biology caps calving at about 85 calves per 100 breeding cows per year, so at most ${fmt(max)} births are possible here. The other ${fmt(r.births_declared - max)} calves have no possible mother on this ranch: they are animals from somewhere else being given a clean birth certificate.`,
        { births_declared: r.births_declared, breeding_cows: r.breeding_cows, max_births: max, excess: r.births_declared - max, calving_rate_max: 0.85 });
    }
    if (r.head_now > r.capacity_head * 1.1) {
      const ratio = r.head_now / r.capacity_head;
      flag(r, 'OVER_CAPACITY', 'high', `${fmt(r.head_now)} head on pasture for ${fmt(r.capacity_head)}`,
        `${fmt(r.pasture_ha)} ha of open pasture can carry about ${fmt(r.capacity_head)} head (1.5 per hectare). Declaring ${ratio.toFixed(2)}× that means animals that exist only on paper, or pasture we cannot see, such as land cleared inside a protected area.`,
        { head_now: r.head_now, capacity_head: r.capacity_head, pasture_ha: r1(r.pasture_ha), ratio: Math.round(ratio * 100) / 100, head_per_ha_max: 1.5 });
    }
    if (r === shortLaunderer) {
      flag(r, 'INSUFFICIENT_HERD', 'high', 'Tried to ship 186 head it did not have',
        'On 9 Apr 2025 this ranch requested a permit for 186 head to the export port, but every animal it had bought was already resold. A ranch cannot ship more animals than it holds, so the ledger refused the permit.',
        { date: '2025-04-09', requested: 186, available: 0, gta: moves.find((m) => m.from === r.id && m.day === shortDay)?.gta ?? null, refused_by_ledger: true });
    }
  }
  // Upstream taint: share of purchased head that traces back to flagged origins.
  const originFlag = (id) => flags.get(id)?.some((f) => f.severity === 'high' && ['POST2020_DEFORESTATION', 'PROTECTED_AREA', 'EMBARGOED', 'PHANTOM_BIRTHS'].includes(f.code)) ?? false;
  const taint = new Map(ranches.map((r) => [r.id, 0]));
  for (let it = 0; it < 12; it++) {
    for (const r of ranches) {
      const ins = movesTo.get(r.id) ?? [];
      const tot = ins.reduce((s, m) => s + m.head, 0);
      if (!tot) continue;
      const tainted = ins.reduce((s, m) => s + m.head * (originFlag(m.from) ? 1 : (taint.get(m.from) ?? 0)), 0);
      taint.set(r.id, tainted / tot);
    }
  }
  for (const r of ranches) {
    r.upstream_taint_pct = r1((taint.get(r.id) ?? 0) * 100);
    const flagged = [...new Set((movesTo.get(r.id) ?? []).filter((m) => originFlag(m.from) || (taint.get(m.from) ?? 0) > 0.3).map((m) => m.from))];
    if (r.median_holding_days != null && r.median_holding_days < 45 && r.share_fast >= 0.5) {
      const sev = r.upstream_taint_pct >= 10 ? 'high' : 'medium';
      flag(r, 'PASS_THROUGH', sev, `Resells animals after a median of ${r.median_holding_days} days`,
        sev === 'high'
          ? `${Math.round(r.share_fast * 100)}% of the lots it bought were sold on within 45 days, far too fast to fatten them (real fattening takes 4 to 12 months). Combined with flagged suppliers, this is the signature of an intermediary that "washes" animals before a slaughterhouse or ship sees them.`
          : `${Math.round(r.share_fast * 100)}% of lots are resold within 45 days. Its suppliers look clean, so this may be a legitimate trader: kept on watch, not blocked.`,
        { median_holding_days: r.median_holding_days, share_resold_within_45d: Math.round(r.share_fast * 100) / 100, lots_bought: r.lots_in, lots_sold: r.lots_out, threshold_days: 45 });
    }
    if (r.upstream_taint_pct >= 10 && !originFlag(r.id)) {
      const sev = r.upstream_taint_pct >= 50 ? 'high' : 'medium';
      flag(r, 'TAINTED_SUPPLY', sev, `${Math.round(r.upstream_taint_pct)}% of animals bought trace back to flagged ranches`,
        `Following the permits upstream, ${Math.round(r.upstream_taint_pct)}% of the head this ranch bought originate on ranches with post-2020 clearing, protected-area pasture, an embargo or impossible births. A check of direct suppliers alone would not see this.`,
        { upstream_taint_pct: r.upstream_taint_pct, flagged_suppliers: flagged.slice(0, 6), hops_checked: 4 });
    }
  }
  // Two mild anomalies on honest ranches (false positives at "watch" level).
  for (const r of [pick(honestFatteners), pick(honestRearers)]) {
    if (flags.get(r.id).length) continue;
    flag(r, 'ANOMALY', 'medium', 'Unusual trading pattern',
      'The anomaly model scores this ranch\'s buying pattern (many small lots from many sellers) as unusual for its size. No hard rule is broken; kept on watch.',
      { isolation_forest_score: Math.round(U(0.62, 0.74) * 100) / 100, top_features: ['seller_diversity', 'lots_per_month'] });
  }
  for (const r of ranches) {
    const fl = flags.get(r.id);
    r.flags = fl;
    r.risk_class = fl.some((f) => f.severity === 'high') ? 'high' : fl.some((f) => f.severity === 'medium') ? 'watch' : 'clean';
    r.score = r.risk_class === 'high' ? U(0.78, 0.98) : r.risk_class === 'watch' ? U(0.42, 0.66) : U(0.03, 0.24);
    r.status_quo_flagged = fl.some((f) => f.severity === 'high' && ['POST2020_DEFORESTATION', 'PROTECTED_AREA', 'EMBARGOED'].includes(f.code));
  }
  for (const m of moves) {
    const r = byId.get(m.from);
    m.suspicious = !!m.rejected || (!!r && (r.risk_class === 'high' || (m.hold != null && m.hold < 45 && r.tags.has('launder'))));
  }

  // ---------------------------------------------------------------- upstream tracing
  const WINDOW = 540;
  const MAX_HOPS = 4;
  const moveByGta = new Map(moves.map((m) => [m.gta, m]));
  const hasFlag = (id, codes, sev) => {
    const r = byId.get(id);
    return !!r && r.flags.some((f) => codes.includes(f.code) && (!sev || f.severity === sev));
  };
  const dirtyPass = (id) => hasFlag(id, ['POST2020_DEFORESTATION', 'PROTECTED_AREA', 'EMBARGOED'], 'high');
  const watchPass = (id) => hasFlag(id, ['POST2020_DEFORESTATION'], 'medium');
  // Flow-weighted upstream attribution. Each unit of head carries the share already
  // tainted (passed through a flagged ranch) or on watch (passed through a small
  // post-2020 clearing). Own production is attributed to the ranch itself.
  function trace(gtas, dateIso, mode = 'detect') {
    const T = mode === 'truth';
    const day = isoToDay(dateIso);
    let frontier = new Map(); // id -> {amt, t (flagged), w (watch)}
    const push = (map, id, amt, t, wv) => {
      const e = map.get(id) ?? { amt: 0, t: 0, w: 0 };
      e.amt += amt; e.t += t; e.w += wv;
      map.set(id, e);
    };
    let total = 0;
    for (const g of gtas) {
      const m = moveByGta.get(g);
      total += m.head;
      push(frontier, m.from, m.head, 0, 0);
    }
    const nodes = new Map(); // id -> {head_equiv, hops}
    const origins = new Map(); // id -> {head_equiv, hops}: where the animals were raised
    let clean = 0, flagged = 0, watch = 0, unknown = 0, maxHop = 0;
    for (let hop = 1; hop <= MAX_HOPS && frontier.size; hop++) {
      const next = new Map();
      for (const [id, e0] of frontier) {
        const e = { ...e0 };
        if (T ? byId.get(id)?.truth === 'dirty_source' : dirtyPass(id)) { e.t = e.amt; e.w = 0; }
        else if (!T && watchPass(id)) e.w = e.amt - e.t;
        maxHop = Math.max(maxHop, hop);
        const n = nodes.get(id) ?? { head_equiv: 0, hops: hop };
        n.head_equiv += e.amt; n.hops = Math.min(n.hops, hop);
        nodes.set(id, n);
        const r = byId.get(id);
        const settle = (frac, originFlagged, isUnknown, asOrigin = true) => {
          const t = e.t * frac, wv = e.w * frac, rest = e.amt * frac - t - wv;
          if (asOrigin && e.amt * frac > 0.01) {
            const o = origins.get(id) ?? { head_equiv: 0, hops: hop };
            o.head_equiv += e.amt * frac; o.hops = Math.min(o.hops, hop);
            origins.set(id, o);
          }
          flagged += t; watch += wv;
          if (originFlagged) flagged += rest; else if (isUnknown) unknown += rest; else clean += rest;
        };
        if (!r) { settle(1, false, true); continue; }
        const ins = (movesTo.get(id) ?? []).filter((m) => m.day <= day && m.day >= day - WINDOW);
        const outs = (movesFrom.get(id) ?? []).filter((m) => m.day <= day && m.day >= day - WINDOW);
        const I_ = ins.reduce((s, m) => s + m.head, 0);
        const O_ = outs.reduce((s, m) => s + m.head, 0);
        const p = O_ > 0 ? Math.min(1, I_ / O_) : I_ > 0 ? 1 : 0;
        settle(1 - p, T ? ['dirty_source', 'phantom_births'].includes(r.truth) : r.risk_class === 'high' && originFlag(id), false);
        if (p <= 0) continue;
        if (hop === MAX_HOPS) { settle(p, false, true, false); continue; }
        const bySup = new Map();
        for (const m of ins) bySup.set(m.from, (bySup.get(m.from) ?? 0) + m.head);
        for (const [s, h] of bySup) { const f = p * (h / I_); push(next, s, e.amt * f, e.t * f, e.w * f); }
      }
      frontier = next;
    }
    const sum = clean + flagged + watch + unknown || 1;
    return {
      head: total,
      clean_pct: r1((clean / sum) * 100),
      watch_pct: r1((watch / sum) * 100),
      flagged_pct: r1((flagged / sum) * 100),
      unknown_pct: r1((unknown / sum) * 100),
      max_hops: maxHop,
      n_origins: origins.size,
      by_ranch: [...origins.entries()]
        .map(([id, n]) => ({ ranch: id, head_equiv: r1(n.head_equiv), risk_class: byId.get(id)?.risk_class ?? 'unknown', hops: n.hops }))
        .sort((a, b) => b.head_equiv - a.head_equiv),
    };
  }
  // EU-bound lots treat watch as failing (zero-deforestation cut-off); other markets do not.
  const verdictOf = (t, market) => {
    const bad = market === 'EU' ? t.flagged_pct + t.watch_pct : t.flagged_pct;
    return bad >= 2 ? 'fail' : bad > 0 || t.unknown_pct >= 10 ? 'review' : 'pass';
  };

  // Candidate shipment clusters: GTAs into the same sink within 21 days.
  const sinkMoves = moves.filter((m) => !m.rejected && (m.to.startsWith('S:') || m.to.startsWith('P:')));
  const clusters = [];
  for (const dest of DESTINATIONS.map((d) => d.id)) {
    const list = sinkMoves.filter((m) => m.to === dest && m.day >= yearStart(2023) + 200).sort((a, b) => a.day - b.day);
    let cur = [];
    for (const m of list) {
      if (cur.length && (m.day - cur[0].day > 21 || cur.length >= 10)) { clusters.push(cur); cur = []; }
      cur.push(m);
    }
    if (cur.length) clusters.push(cur);
  }
  const evalCluster = (c) => {
    const date = dayToIso(c[c.length - 1].day + (c[0].to === PORT ? 3 : 0));
    const t = trace(c.map((m) => m.gta), date);
    const sq = c.some((m) => byId.get(m.from)?.status_quo_flagged) ? 'fail' : 'pass';
    return { c, date, t, sq, rvEU: verdictOf(t, 'EU'), rvOther: verdictOf(t, 'TR'), dest: c[0].to, head: t.head };
  };
  const evals = clusters.filter((c) => c.length >= 2).map(evalCluster);
  const used = new Set();
  const choose = (pred, score) => {
    const cands = evals.filter((e) => !used.has(e) && pred(e)).sort((a, b) => score(b) - score(a));
    if (!cands.length) return null;
    used.add(cands[0]);
    return cands[0];
  };
  const isSIF = (e) => e.dest.startsWith('S:SIF');
  const picks = [
    ['TR', choose((e) => e.dest === PORT && e.sq === 'pass' && e.rvOther === 'fail' && e.t.flagged_pct >= 18 && e.t.flagged_pct <= 65 && e.head >= 600, (e) => e.head + e.c.length * 50)],
    ['EU', choose((e) => isSIF(e) && e.sq === 'pass' && e.rvEU === 'pass', (e) => e.head)],
    ['EU', choose((e) => isSIF(e) && e.sq === 'pass' && e.rvEU === 'fail' && e.t.watch_pct > 0, (e) => e.t.watch_pct + e.t.flagged_pct)],
    ['TR', choose((e) => e.dest === PORT && e.sq === 'fail', (e) => e.head)],
    ['CN', choose((e) => isSIF(e) && e.rvOther !== 'fail', (e) => e.t.unknown_pct + e.head / 1000)],
    ['BR', choose((e) => e.dest.startsWith('S:SIE'), (e) => (e.rvOther === 'pass' ? 1e4 : 0) + e.head)],
    ['TR', choose((e) => e.dest === PORT, (e) => e.head)],
    ['BR', choose((e) => isSIF(e), (e) => e.head)],
  ];

  return { ranches, byId, flags, moves, deforFeatures, paRing, PA_NAME, picks, trace, verdictOf, sinkMoves, embargoed, shortLaunderer, launderers, originFlag, taint, phantoms };
}

// ---------------------------------------------------------------- choose a seed that yields the full demo story
let seed = Number(process.argv[2]) || 20261025;
let w;
for (let tries = 0; tries < 400; tries++, seed++) {
  w = build(seed);
  const ok = w.picks.slice(0, 4).every(([, e]) => e) && w.picks.filter(([, e]) => e).length >= 7;
  if (ok && w.moves.length >= 260 && w.moves.length <= 520) break;
}
console.log(`seed ${seed}: ${w.ranches.length} ranches, ${w.moves.length} movements, ${w.deforFeatures.length} clearings`);

const { ranches, moves, deforFeatures, paRing, PA_NAME, picks, trace, embargoed } = w;

// Evidence bundles: pretty-printed JSON; the anchored hash is SHA-256 of the exact file bytes.
const EVID = path.join(OUT, 'evidence');
fs.rmSync(EVID, { recursive: true, force: true });
fs.mkdirSync(EVID, { recursive: true });
const writeEvidence = (obj) => {
  const bytes = Buffer.from(JSON.stringify(obj, null, 2) + '\n', 'utf-8');
  const hex = crypto.createHash('sha256').update(bytes).digest('hex');
  fs.writeFileSync(path.join(EVID, hex + '.json'), bytes);
  return '0x' + hex;
};
for (const r of ranches) {
  r.evidence_hash = writeEvidence({
    kind: 'risk_attestation',
    notice: 'MOCK evidence bundle (synthetic)',
    ranch: r.id,
    onchain_id: r.onchain_id,
    as_of: '2026-10-24',
    model: 'rastro-detect (mock run)',
    risk: { class: r.risk_class, score: Math.round(r.score * 100) / 100 },
    inputs: {
      head_now: r.head_now, capacity_head: r.capacity_head, pasture_ha: r1(r.pasture_ha), breeding_cows: r.breeding_cows,
      births_declared: r.births_declared, births_biological_max: r.births_biological_max,
      inflow_head: r.inflow_head, outflow_head: r.outflow_head, median_holding_days: r.median_holding_days,
      defor_post2020_ha: r1(r.defor_post2020_ha), upstream_taint_pct: r.upstream_taint_pct,
    },
    flags: r.flags.map((f) => ({ code: f.code, severity: f.severity, evidence: f.evidence })),
  });
}

// ---------------------------------------------------------------- shipments
const shipments = picks.filter(([, e]) => e).map(([market, e], i) => {
  const id = 'SHP-' + String(i + 1).padStart(4, '0');
  const { head, ...t } = e.t;
  const rv = market === 'EU' ? e.rvEU : e.rvOther;
  const verdict = rv === 'pass' ? 'clean' : rv === 'fail' ? 'flagged' : 'unknown';
  return {
    id, kind: e.dest.startsWith('P:') ? 'voyage' : 'delivery', destination: e.dest, market, head, date: e.date,
    gtas: e.c.map((m) => m.gta),
    trace: { ...t, by_ranch: t.by_ranch.slice(0, 40) },
    direct_suppliers: [...new Set(e.c.map((m) => m.from))].sort(),
    status_quo_verdict: e.sq, rastro_verdict: rv,
    certificate: {
      lot_id: sha('lot:' + id), verdict,
      evidence_hash: writeEvidence({
        kind: 'lot_certificate', notice: 'MOCK evidence bundle (synthetic)', shipment: id, lot_id: sha('lot:' + id),
        destination: e.dest, market, head, date: e.date, gtas: e.c.map((m) => m.gta),
        trace: { clean_pct: t.clean_pct, watch_pct: t.watch_pct, flagged_pct: t.flagged_pct, unknown_pct: t.unknown_pct, max_hops: t.max_hops, by_ranch: t.by_ranch.slice(0, 15) },
        verdict, rule: market === 'EU' ? 'EU: fail if flagged + watch >= 2%' : 'fail if flagged >= 2%',
      }),
    },
  };
});
for (const s of shipments) console.log(`  ${s.id} ${s.destination.padEnd(13)} ${s.market} ${String(s.head).padStart(5)} head  clean ${s.trace.clean_pct}% watch ${s.trace.watch_pct}% flagged ${s.trace.flagged_pct}% unknown ${s.trace.unknown_pct}%  status quo ${s.status_quo_verdict} / rastro ${s.rastro_verdict}`);

// ---------------------------------------------------------------- evaluation metrics
const truthPos = (r) => r.truth !== 'honest';
const prf = (pred) => {
  const tp = ranches.filter((r) => pred(r) && truthPos(r)).length;
  const fp = ranches.filter((r) => pred(r) && !truthPos(r)).length;
  const fn = ranches.filter((r) => !pred(r) && truthPos(r)).length;
  return { precision: Math.round((tp / Math.max(1, tp + fp)) * 100) / 100, recall: Math.round((tp / Math.max(1, tp + fn)) * 100) / 100 };
};
let taintedTotal = 0, sqCaught = 0, rastroCaught = 0, cleanLots = 0, sqFailClean = 0, rFailClean = 0;
for (const m of w.sinkMoves) {
  const truthT = trace([m.gta], m.date, 'truth');
  const t = trace([m.gta], m.date);
  const f = (truthT.flagged_pct / 100) * m.head;
  taintedTotal += f;
  if (w.byId.get(m.from)?.status_quo_flagged) sqCaught += f;
  const rFails = w.verdictOf(t, 'TR') !== 'pass' || w.byId.get(m.from)?.risk_class === 'high';
  if (rFails) rastroCaught += f;
  if (truthT.flagged_pct === 0) {
    cleanLots++;
    if (w.byId.get(m.from)?.status_quo_flagged) sqFailClean++;
    if (w.verdictOf(t, 'TR') === 'fail') rFailClean++;
  }
}
const sqPct = r1((sqCaught / taintedTotal) * 100);
const rPct = r1((rastroCaught / taintedTotal) * 100);
const metrics = {
  counts: { ranches: ranches.length, movements: moves.length, head_moved: moves.reduce((s, m) => s + m.head, 0), shipments: shipments.length },
  eval: {
    status_quo: { ...prf((r) => r.status_quo_flagged), tainted_head_caught_pct: sqPct, clean_lots_failed_pct: r1((sqFailClean / Math.max(1, cleanLots)) * 100) },
    rastro: { ...prf((r) => r.risk_class === 'high'), tainted_head_caught_pct: rPct, clean_lots_failed_pct: r1((rFailClean / Math.max(1, cleanLots)) * 100) },
    lots: w.sinkMoves.length,
    tainted_head_at_sinks: Math.round(taintedTotal),
  },
  ledger: {
    refused: Object.fromEntries(
      ['OriginEmbargoed', 'InsufficientHerd'].map((k) => [k, { gtas_or_events: moves.filter((m) => m.rejected === k).length, head: moves.filter((m) => m.rejected === k).reduce((a, m) => a + m.head, 0) }]),
    ),
  },
  thresholds: { fail_flagged_pct: 2, review_flagged_pct: 0.1 },
  headline: {
    tainted_head_pct_passing_status_quo: r1(100 - sqPct),
    tainted_head_pct_caught_rastro: rPct,
    laundering_ranches_found: ranches.filter((r) => r.risk_class === 'high' && !r.status_quo_flagged && truthPos(r)).length,
  },
  real_data: {
    prodes_polygons: deforFeatures.length,
    defor_post2020_ha: Math.round(deforFeatures.filter((f) => f.properties.year >= 2021).reduce((s, f) => s + f.properties.area_ha, 0)),
    ibge_herd_municipality: 2452095,
    ibge_year: 2023,
  },
};
console.log('metrics', JSON.stringify(metrics.eval), JSON.stringify(metrics.headline));

// ---------------------------------------------------------------- write files
const write = (rel, obj) => {
  const p = path.join(OUT, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj) + '\n');
};
fs.mkdirSync(OUT, { recursive: true });

write('meta.json', {
  project: 'Rastro',
  aoi: { name: 'São Félix do Xingu, Pará (study window)', bbox: [-52.4, -6.9, -51.8, -6.3] },
  generated_at: '2026-10-24T12:00:00Z',
  years: [2023, 2024, 2025],
  eudr_cutoff: '2020-12-31',
  synthetic_notice: 'MOCK BUNDLE for interface preview: every layer here is generated, including deforestation and the protected-area outline. In the real bundle, ranch boundaries, herds and GTAs are synthetic (calibrated to public aggregates) while deforestation, protected areas, slaughterhouses and municipal herd are real.',
  sources: [
    { name: 'INPE PRODES yearly deforestation (TerraBrasilis)', url: 'https://terrabrasilis.dpi.inpe.br', license: 'CC BY-SA 4.0', real: true },
    { name: 'Conservation units and Indigenous lands (TerraBrasilis)', url: 'https://terrabrasilis.dpi.inpe.br', license: 'CC BY-SA 4.0', real: true },
    { name: 'IBGE PPM municipal herd, SIDRA table 3939', url: 'https://sidra.ibge.gov.br/tabela/3939', license: 'Public data (IBGE)', real: true },
    { name: 'Trase logistics map: slaughterhouses and ports', url: 'https://trase.earth', license: 'CC BY 4.0', real: true },
    { name: 'Synthetic GTA simulator (Rastro)', url: '', license: 'Generated', real: false },
  ],
});

write('ranches.geojson', {
  type: 'FeatureCollection',
  features: ranches.map((r) => ({
    type: 'Feature',
    properties: {
      id: r.id, onchain_id: r.onchain_id, role: r.role,
      area_ha: r1(r.area_ha), pasture_ha: r1(r.pasture_ha), capacity_head: r.capacity_head, head_now: r.head_now, breeding_cows: r.breeding_cows,
      births_declared: r.births_declared, births_biological_max: r.births_biological_max, capacity_peak_pct: r.capacity_peak_pct,
      defor_by_year: Object.fromEntries([...r.defor.reduce((m, d) => m.set(d.year, (m.get(d.year) ?? 0) + d.ha), new Map())].sort((a, b) => a[0] - b[0]).map(([y, ha]) => [String(y), r1(ha)])),
      ti_overlap_ha: r.in_protected ? r1(r.flags.find((f) => f.code === 'PROTECTED_AREA')?.evidence?.overlap_ha ?? 0) : 0,
      uc_overlap_ha: 0,
      rejected_gtas: r.rejected_gtas,
      defor_post2008_ha: r1(r.defor_post2008_ha), defor_post2020_ha: r1(r.defor_post2020_ha),
      in_protected: r.in_protected, protected_name: r.in_protected ? PA_NAME : null,
      embargoed: r === embargoed,
      inflow_head: r.inflow_head, outflow_head: r.outflow_head, median_holding_days: r.median_holding_days,
      risk: { class: r.risk_class, score: Math.round(r.score * 100) / 100, flags: r.flags, evidence_hash: r.evidence_hash },
      upstream_taint_pct: r.upstream_taint_pct,
      status_quo_flagged: r.status_quo_flagged,
      truth: r.truth,
    },
    geometry: { type: 'Polygon', coordinates: [r.ring] },
  })),
});

write('movements.json', moves.map((m) => ({ gta: m.gta, hash: m.hash, from: m.from, to: m.to, head: m.head, date: m.date, purpose: m.purpose, suspicious: m.suspicious, rejected: m.rejected ?? null })));
write('destinations.json', DESTINATIONS);
write('shipments.json', shipments);
write('metrics.json', metrics);
write('layers/deforestation.geojson', { type: 'FeatureCollection', features: deforFeatures });
write('layers/protected.geojson', { type: 'FeatureCollection', features: [{ type: 'Feature', properties: { name: PA_NAME, kind: 'indigenous' }, geometry: { type: 'Polygon', coordinates: [paRing] } }] });
const [x0, y0, x1, y1] = [-52.4, -6.9, -51.8, -6.3];
write('layers/aoi.geojson', { type: 'FeatureCollection', features: [{ type: 'Feature', properties: { name: 'São Félix do Xingu study window' }, geometry: { type: 'Polygon', coordinates: [[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]] } }] });

// ---------------------------------------------------------------- on-chain replay record (mock)
let block = 1;
const tx = (s) => sha('tx:' + s);
const records = [];
const rec = (kind, ref, note, extra = {}) => records.push({ kind, ref, tx: tx(kind + ref + records.length), block: block++, status: 'success', revert_reason: null, note, ...extra });
for (const r of ranches) rec('registerRanch', r.id, `capacity ${r.capacity_head} head, ${r.head_now} on hand`);
const certGtas = new Set(shipments.flatMap((s) => s.gtas));
for (const m of moves.filter((m) => certGtas.has(m.gta))) rec('recordMovement', m.gta, `${m.from} → ${m.to}, ${m.head} head`);
for (const r of ranches) rec('attestRisk', r.id, `risk ${r.risk_class}, score ${Math.round(r.score * 100) / 100}`, { evidence_hash: r.evidence_hash });
for (const s of shipments) rec('issueCertificate', s.id, `lot ${s.certificate.lot_id.slice(0, 10)}…, verdict ${s.certificate.verdict}, ${s.head} head`, { evidence_hash: s.certificate.evidence_hash });
const cleanShp = shipments.find((s) => s.certificate.verdict === 'clean' && s.market === 'EU') ?? shipments.find((s) => s.certificate.verdict === 'clean');
const flaggedShp = shipments.find((s) => s.certificate.verdict === 'flagged' && s.market === 'TR') ?? shipments.find((s) => s.certificate.verdict === 'flagged');
if (cleanShp) rec('consumeCertificate', cleanShp.id, `consumed once for an export shipment (${cleanShp.market})`);
const demo = (ref, reason, note) => records.push({ kind: 'revertDemo', ref, tx: null, block: block - 1, status: 'reverted', revert_reason: reason, note });
if (cleanShp) demo(cleanShp.id, `CertificateAlreadyUsed(${cleanShp.certificate.lot_id})`, 'eth_call: a second consumeCertificate on the same lot');
if (flaggedShp) demo(flaggedShp.id, `CertificateNotClean(${flaggedShp.certificate.lot_id})`, 'eth_call: consumeCertificate on a lot whose verdict is flagged');
demo(embargoed.id, `OriginEmbargoed(${embargoed.onchain_id})`, `eth_call: recordMovement out of ${embargoed.id} after setEmbargo`);
demo('PHANTOM_BIRTHS', `BirthsExceedBiology(${sha('ranch:demo-intermediary')}, 2025, 500, 34)`, 'eth_call: recordBirths of 500 calves for an intermediary with 40 breeding cows (max 34)');

write('onchain.json', {
  network: 'anvil', chainId: 31337, address: '0x5FbDB2315678afecb367f032d93F642f64180aa3',
  explorer: null, rpc: null, deploy_tx: tx('deploy'),
  records,
  abi_path: 'data/HerdLedger.abi.json',
  roles: { registrar: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8', issuer: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8', regulator: '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC', buyer: '0x90F79bf6EB2c4f870365E785982E1f101E93b906', oracle: '0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc' },
  demo: { labels: { tr: flaggedShp?.id ?? null, eu: cleanShp?.id ?? null, embargoed_ranch: embargoed.id } },
});

// Minimal ABI matching SPEC section 4 (used only to decode live revert data).
const b32 = (name) => ({ name, type: 'bytes32' });
const fn = (name, inputs, mut = 'nonpayable') => ({ type: 'function', name, inputs, outputs: [], stateMutability: mut });
const err = (name, inputs = []) => ({ type: 'error', name, inputs });
write('HerdLedger.abi.json', [
  fn('registerRanch', [b32('id'), { name: 'capacityHead', type: 'uint32' }, { name: 'initialHead', type: 'uint32' }, { name: 'breedingCows', type: 'uint32' }, b32('geomHash')]),
  fn('recordMovement', [b32('gtaHash'), b32('from'), b32('to'), { name: 'head', type: 'uint32' }, { name: 'purpose', type: 'uint8' }, { name: 'date', type: 'uint64' }]),
  fn('consumeCertificate', [b32('lotId'), { name: 'use', type: 'uint8' }, b32('refHash')]),
  fn('setEmbargo', [b32('ranch'), { name: 'on', type: 'bool' }, b32('reasonHash')]),
  err('UnknownEntity', [b32('id')]),
  err('DuplicateGta', [b32('gtaHash')]),
  err('OriginEmbargoed', [b32('from')]),
  err('InsufficientHerd', [b32('from'), { name: 'have', type: 'uint32' }, { name: 'need', type: 'uint32' }]),
  err('BirthsExceedBiology', [b32('ranch'), { name: 'year', type: 'uint16' }, { name: 'total', type: 'uint32' }, { name: 'max', type: 'uint32' }]),
  err('GtaAlreadyCertified', [b32('gtaHash')]),
  err('CertificateAlreadyUsed', [b32('lotId')]),
  err('CertificateNotClean', [b32('lotId')]),
  err('CertificateRevoked', [b32('lotId')]),
]);
console.log('wrote', OUT);
