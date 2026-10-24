// Builds the "Can this buyer know?" Sankey for one shipment.
//
// Columns: origin ranches (where the animals were raised, from the pipeline's
// trace.by_ranch) -> direct suppliers (the GTAs into the sink: all that today's
// check looks at) -> the shipment. Band widths are the pipeline's head-equivalents;
// which direct supplier each origin fed is read from movements.json. Whatever the
// listed origins do not explain is shown as "other origins", so every direct
// supplier's bar balances exactly with its GTAs.
//
// If shipments[].trace.links ({origin, via, head, class}) is present, those exact
// origin -> direct-supplier edges are drawn instead.

import type { Movement, Ranch, Shipment, TraceClass } from './types';
import type { MoveIndex } from './data';

export type NodeCls = TraceClass | 'other' | 'shipment';
export interface TNode {
  id: string; label: string; sub: string; cls: NodeCls; col: number; value: number;
  ranchId?: string; hops?: number; kind: 'origin' | 'direct' | 'ship' | 'other' | 'hop';
}
export interface TLink { source: string; target: string; value: number; cls: NodeCls }
export interface DerivedTrace { nodes: TNode[]; links: TLink[]; columns: number; total: number; exact: boolean; directCount: number; originsShown: number }

const DAY = 86400000;
const dayOf = (iso: string) => Math.floor(Date.parse(iso.slice(0, 10) + 'T00:00:00Z') / DAY);
export const SHIP_NODE = '__shipment';
const OTHER = '__other_origins_';
type OtherCls = 'high' | 'watch' | 'clean' | 'unknown';
const OTHER_CLASSES: OtherCls[] = ['high', 'watch', 'clean', 'unknown'];
const OTHER_DIRECT = '__other_direct';

const clsOfRanch = (r: Ranch | undefined): NodeCls => (r ? r.risk.class : 'unknown');
const asCls = (c: string | undefined): NodeCls => (c === 'clean' || c === 'watch' || c === 'high' ? c : 'unknown');

export function buildSankey(ship: Shipment, idx: MoveIndex | null, ranchById: Map<string, Ranch>, maxDirect = 16): DerivedTrace {
  if (ship.trace?.links?.some((l) => l && l.via)) return fromLinks(ship, ranchById, maxDirect);

  const day = dayOf(ship.date);
  const inWin = (m: Movement, back = 720) => {
    const d = dayOf(m.date);
    return d <= day && d >= day - back;
  };

  // Direct suppliers and the head each one delivered in this shipment.
  const direct = new Map<string, number>();
  for (const g of ship.gtas ?? []) {
    const m = idx?.byGta.get(g);
    if (m) direct.set(m.from, (direct.get(m.from) ?? 0) + m.head);
  }
  if (!direct.size && Array.isArray(ship.direct_suppliers)) {
    const list = ship.direct_suppliers as string[];
    for (const id of list) direct.set(id, ship.head / list.length);
  }
  const total = [...direct.values()].reduce((s, v) => s + v, 0) || ship.head;

  const byRanch = [...(ship.trace?.by_ranch ?? [])].sort((a, b) => b.head_equiv - a.head_equiv);
  const own = new Map<string, number>(); // origin == the direct supplier itself
  const upstream = byRanch.filter((o) => {
    if (direct.has(o.ranch) && o.hops <= 1) {
      own.set(o.ranch, (own.get(o.ranch) ?? 0) + o.head_equiv);
      return false;
    }
    return true;
  });

  // Fold the smallest direct suppliers if there are many.
  const directSorted = [...direct.entries()].sort((a, b) => b[1] - a[1]);
  const fold = new Map<string, string>();
  if (directSorted.length > maxDirect) for (const [id] of directSorted.slice(maxDirect - 1)) fold.set(id, OTHER_DIRECT);
  const fd = (id: string) => fold.get(id) ?? id;

  // Origin -> direct supplier weights from the movement graph.
  const raw = new Map<string, Map<string, number>>(); // origin -> (direct -> value)
  for (const o of upstream) {
    const w = new Map<string, number>();
    const outs = (idx?.byFrom.get(o.ranch) ?? []).filter((m) => inWin(m));
    for (const m of outs) if (direct.has(m.to)) w.set(m.to, (w.get(m.to) ?? 0) + m.head);
    if (!w.size) {
      // two-step paths: origin -> X -> direct supplier
      for (const m1 of outs) {
        for (const m2 of idx?.byFrom.get(m1.to) ?? []) {
          if (direct.has(m2.to) && m2.date >= m1.date && inWin(m2)) w.set(m2.to, (w.get(m2.to) ?? 0) + Math.min(m1.head, m2.head));
        }
      }
    }
    if (!w.size) for (const [d, h] of direct) w.set(d, h);
    const sum = [...w.values()].reduce((s, v) => s + v, 0) || 1;
    const out = new Map<string, number>();
    for (const [d, v] of w) out.set(d, (o.head_equiv * v) / sum);
    raw.set(o.ranch, out);
  }
  // Cap each direct supplier's inflow at what it actually delivered (minus its own-raised share).
  const inflow = new Map<string, number>();
  for (const [, m] of raw) for (const [d, v] of m) inflow.set(d, (inflow.get(d) ?? 0) + v);
  const scale = new Map<string, number>();
  for (const [d, h] of direct) {
    const cap = Math.max(0, h - (own.get(d) ?? 0));
    const got = inflow.get(d) ?? 0;
    scale.set(d, got > cap && got > 0 ? cap / got : 1);
  }

  const linkMap = new Map<string, { v: number; cls: NodeCls }>();
  const add = (s: string, t: string, v: number, cls: NodeCls) => {
    if (v <= 0.01) return;
    const k = `${s}|${t}`;
    const e = linkMap.get(k);
    if (e) e.v += v;
    else linkMap.set(k, { v, cls });
  };
  const explained = new Map<string, number>();
  for (const o of upstream) {
    for (const [d, v0] of raw.get(o.ranch) ?? []) {
      const v = v0 * (scale.get(d) ?? 1);
      explained.set(d, (explained.get(d) ?? 0) + v);
      add(o.ranch, fd(d), v, asCls(o.risk_class));
    }
  }
  // Split the unexplained remainder by class so the origin column matches the
  // pipeline's clean / watch / flagged / unknown percentages.
  const t = ship.trace ?? ({} as Shipment['trace']);
  const pctOf: Record<OtherCls, number> = { high: t.flagged_pct ?? 0, watch: t.watch_pct ?? 0, clean: t.clean_pct ?? 0, unknown: t.unknown_pct ?? 0 };
  const remCls: Record<OtherCls, number> = { high: 0, watch: 0, clean: 0, unknown: 0 };
  for (const c of OTHER_CLASSES) {
    const shown = byRanch.filter((o) => asCls(o.risk_class) === c).reduce((s, o) => s + o.head_equiv, 0);
    remCls[c] = Math.max(0, (pctOf[c] / 100) * total - shown);
  }
  const remSum = OTHER_CLASSES.reduce((s, c) => s + remCls[c], 0);
  const otherTotals: Record<OtherCls, number> = { high: 0, watch: 0, clean: 0, unknown: 0 };
  for (const [d, h] of direct) {
    const rem = h - (own.get(d) ?? 0) - (explained.get(d) ?? 0);
    if (rem > 0.5) {
      for (const c of OTHER_CLASSES) {
        const share = remSum > 0 ? remCls[c] / remSum : c === 'unknown' ? 1 : 0;
        const v = rem * share;
        if (v > 0.5) {
          add(OTHER + c, fd(d), v, c);
          otherTotals[c] += v;
        }
      }
    }
    add(fd(d), SHIP_NODE, h, fd(d) === OTHER_DIRECT ? 'other' : clsOfRanch(ranchById.get(d)));
  }

  const nodes: TNode[] = [];
  const used = new Set<string>();
  for (const k of linkMap.keys()) k.split('|').forEach((x) => used.add(x));
  const nOrigins = Number((ship.trace as { n_origins?: number })?.n_origins ?? byRanch.length);
  for (const o of upstream) {
    if (!used.has(o.ranch)) continue;
    const r = ranchById.get(o.ranch);
    nodes.push({
      id: o.ranch, label: o.ranch, sub: `${r ? r.role : 'outside window'} · ${o.hops} hop${o.hops === 1 ? '' : 's'}`,
      cls: asCls(o.risk_class), col: 0, value: o.head_equiv, ranchId: r ? o.ranch : undefined, hops: o.hops, kind: 'origin',
    });
  }
  const more = Math.max(0, nOrigins - upstream.length - own.size);
  const OTHER_LABEL: Record<OtherCls, string> = { high: 'Other flagged origins', watch: 'Other watch-list origins', clean: 'Other clean origins', unknown: 'Unknown origin' };
  for (const c of OTHER_CLASSES) {
    if (!used.has(OTHER + c)) continue;
    nodes.push({ id: OTHER + c, label: OTHER_LABEL[c], sub: more > 0 ? `part of ${more} smaller origins` : 'smaller origins', cls: c, col: 0, value: otherTotals[c], kind: 'other' });
  }
  for (const [d, h] of directSorted) {
    if (fold.has(d)) continue;
    const r = ranchById.get(d);
    nodes.push({ id: d, label: d, sub: r ? r.role : 'outside window', cls: clsOfRanch(r), col: 1, value: h, ranchId: r ? d : undefined, kind: 'direct' });
  }
  if (used.has(OTHER_DIRECT)) {
    const n = fold.size;
    nodes.push({ id: OTHER_DIRECT, label: `+${n} more`, sub: 'smaller direct suppliers', cls: 'other', col: 1, value: 0, kind: 'other' });
  }
  nodes.push({ id: SHIP_NODE, label: ship.id, sub: `${Math.round(ship.head).toLocaleString('en-US')} head`, cls: 'shipment', col: 2, value: total, kind: 'ship' });

  const links: TLink[] = [...linkMap.entries()].map(([k, e]) => {
    const [source, target] = k.split('|');
    return { source, target, value: e.v, cls: e.cls };
  });
  return { nodes, links, columns: 3, total, exact: false, directCount: direct.size, originsShown: upstream.filter((o) => used.has(o.ranch)).length };
}

/**
 * Exact Sankey from the pipeline's trace.links = [{origin, via, head, class}].
 * `via` is the direct supplier; `origin: "other:<class>"` aggregates the long tail.
 * Origin nodes get an "o:" prefix so a ranch can appear both as an origin (it raised
 * the animals) and as a direct supplier (it sold them to the sink).
 */
function fromLinks(ship: Shipment, ranchById: Map<string, Ranch>, maxDirect: number, maxOrigins = 18): DerivedTrace {
  const raw = (ship.trace.links ?? []).filter((l) => l && l.via && Number(l.head) > 0);
  const clsOfLink = (c: string | undefined): NodeCls => (c === 'flagged' || c === 'high' ? 'high' : c === 'watch' ? 'watch' : c === 'clean' ? 'clean' : 'unknown');
  const hopOf = new Map((ship.trace.by_ranch ?? []).map((b) => [b.ranch, b.hops]));

  // Rank explicit origins by head; fold the tail into per-class "other" buckets.
  const originHead = new Map<string, number>();
  for (const l of raw) if (!String(l.origin).startsWith('other')) originHead.set(l.origin, (originHead.get(l.origin) ?? 0) + Number(l.head));
  const keepOrigins = new Set([...originHead.entries()].sort((a, b) => b[1] - a[1]).slice(0, maxOrigins).map(([id]) => id));
  const directHead = new Map<string, number>();
  for (const l of raw) directHead.set(l.via, (directHead.get(l.via) ?? 0) + Number(l.head));
  const directSorted = [...directHead.entries()].sort((a, b) => b[1] - a[1]);
  const foldDirect = new Set(directSorted.length > maxDirect ? directSorted.slice(maxDirect - 1).map(([id]) => id) : []);
  const fd = (id: string) => (foldDirect.has(id) ? OTHER_DIRECT : id);

  const linkMap = new Map<string, { v: number; cls: NodeCls }>();
  const add = (s: string, t: string, v: number, cls: NodeCls) => {
    if (v <= 0) return;
    const k = `${s}|${t}`;
    const e = linkMap.get(k);
    if (e) e.v += v;
    else linkMap.set(k, { v, cls });
  };
  const otherTotals = new Map<NodeCls, number>();
  const originCls = new Map<string, NodeCls>();
  for (const l of raw) {
    const cls = clsOfLink(l.class);
    const isOther = String(l.origin).startsWith('other') || !keepOrigins.has(l.origin);
    const src = isOther ? OTHER + cls : 'o:' + l.origin;
    if (isOther) otherTotals.set(cls, (otherTotals.get(cls) ?? 0) + Number(l.head));
    else originCls.set(l.origin, cls);
    add(src, fd(l.via), Number(l.head), cls);
  }
  for (const [d, h] of directHead) add(fd(d), SHIP_NODE, h, fd(d) === OTHER_DIRECT ? 'other' : clsOfRanch(ranchById.get(d)));

  const used = new Set<string>();
  for (const k of linkMap.keys()) k.split('|').forEach((x) => used.add(x));
  const nodes: TNode[] = [];
  for (const id of keepOrigins) {
    const nid = 'o:' + id;
    if (!used.has(nid)) continue;
    const r = ranchById.get(id);
    const self = directHead.has(id) && raw.some((l) => l.origin === id && l.via === id);
    const hops = hopOf.get(id);
    nodes.push({
      id: nid, label: id,
      sub: `${r ? r.role : 'outside window'} · ${self && (hops == null || hops <= 1) ? 'raised by the supplier' : hops != null ? `${hops} hop${hops === 1 ? '' : 's'}` : 'upstream'}`,
      cls: originCls.get(id) ?? 'unknown', col: 0, value: originHead.get(id) ?? 0, ranchId: r ? id : undefined, hops, kind: 'origin',
    });
  }
  const nOrigins = Number(ship.trace.n_origins ?? keepOrigins.size);
  const more = Math.max(0, nOrigins - keepOrigins.size);
  const OTHER_LABEL: Record<string, string> = { high: 'Other flagged origins', watch: 'Other watch-list origins', clean: 'Other clean origins', unknown: 'Unknown origin' };
  for (const [cls, v] of otherTotals) {
    if (!used.has(OTHER + cls)) continue;
    nodes.push({ id: OTHER + cls, label: OTHER_LABEL[cls] ?? 'Other origins', sub: more > 0 ? `part of ${more} smaller origins` : 'smaller origins', cls, col: 0, value: v, kind: 'other' });
  }
  for (const [d, h] of directSorted) {
    if (foldDirect.has(d)) continue;
    const r = ranchById.get(d);
    nodes.push({ id: d, label: d, sub: r ? String(r.role) : 'outside window', cls: clsOfRanch(r), col: 1, value: h, ranchId: r ? d : undefined, kind: 'direct' });
  }
  if (used.has(OTHER_DIRECT)) nodes.push({ id: OTHER_DIRECT, label: `+${foldDirect.size} more`, sub: 'smaller direct suppliers', cls: 'other', col: 1, value: 0, kind: 'other' });
  const total = [...directHead.values()].reduce((s, v) => s + v, 0) || ship.head;
  nodes.push({ id: SHIP_NODE, label: ship.id, sub: `${Math.round(ship.head).toLocaleString('en-US')} head`, cls: 'shipment', col: 2, value: total, kind: 'ship' });
  const links: TLink[] = [...linkMap.entries()].map(([k, e]) => {
    const [source, target] = k.split('|');
    return { source, target, value: e.v, cls: e.cls };
  });
  return { nodes, links, columns: 3, total, exact: true, directCount: directHead.size, originsShown: keepOrigins.size };
}
