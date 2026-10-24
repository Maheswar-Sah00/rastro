// Animal-flow aggregation for the map. Movements are pre-aggregated once
// (pair x year x kind) so filter changes only touch a few thousand rows.

import type { Destination, Movement, Position, Ranch } from './types';
import { arc } from './geo';

export type FlowType = 'all' | 'suspicious' | 'ranch' | 'slaughter' | 'export' | 'rejected';
type Group = 'ranch' | 'slaughter' | 'export';

export interface FlowAgg { from: string; to: string; year: number; group: Group; susp: boolean; rejected: boolean; head: number; n: number }

export function aggregateMovements(moves: Movement[]): FlowAgg[] {
  const m = new Map<string, FlowAgg>();
  for (const mv of moves) {
    const year = Number(mv.date.slice(0, 4));
    const group: Group = mv.to.startsWith('P:') ? 'export' : mv.to.startsWith('S:') ? 'slaughter' : 'ranch';
    const susp = !!mv.suspicious;
    const rejected = !!mv.rejected;
    const k = `${mv.from}|${mv.to}|${year}|${susp ? 1 : 0}|${rejected ? 1 : 0}`;
    const e = m.get(k);
    if (e) {
      e.head += mv.head;
      e.n += 1;
    } else m.set(k, { from: mv.from, to: mv.to, year, group, susp, rejected, head: mv.head, n: 1 });
  }
  return [...m.values()];
}

export interface FlowFilter { years: number[] | null; type: FlowType; hiddenClasses: Set<string>; selected: string | null; limit: number }

export interface FlowLineProps { from: string; to: string; head: number; n: number; susp_head: number; susp: number; rejected: number; group: Group; rank: number }

export function buildFlowLines(
  aggs: FlowAgg[],
  f: FlowFilter,
  ranchById: Map<string, Ranch>,
  destById: Map<string, Destination>,
) {
  const pos = (id: string): Position | null => {
    const r = ranchById.get(id);
    if (r) return r.centroid;
    const d = destById.get(id);
    return d ? [d.lon, d.lat] : null;
  };
  const pair = new Map<string, FlowLineProps & { rej: boolean }>();
  let totalHead = 0, suspHead = 0, nGta = 0;
  for (const a of aggs) {
    if (f.years && !f.years.includes(a.year)) continue;
    if (f.type === 'rejected' ? !a.rejected : a.rejected && f.type !== 'all') continue;
    if (f.type === 'suspicious' && !a.susp) continue;
    if ((f.type === 'ranch' || f.type === 'slaughter' || f.type === 'export') && a.group !== f.type) continue;
    const fr = ranchById.get(a.from);
    if (fr && f.hiddenClasses.has(fr.risk.class)) continue;
    const k = `${a.from}|${a.to}|${a.rejected ? 1 : 0}`;
    let e = pair.get(k);
    if (!e) pair.set(k, (e = { from: a.from, to: a.to, head: 0, n: 0, susp_head: 0, susp: 0, rejected: a.rejected ? 1 : 0, group: a.group, rank: 0, rej: a.rejected }));
    e.head += a.head;
    e.n += a.n;
    if (a.susp) e.susp_head += a.head;
    totalHead += a.head;
    nGta += a.n;
    if (a.susp) suspHead += a.head;
  }
  const all = [...pair.values()].sort((a, b) => b.head - a.head);
  // Refused permits are always drawn when asked for, otherwise only the 40 largest (plus the selected ranch's).
  let rejShown = 0;
  const keep = all.filter((p, i) => {
    if (f.selected && (p.from === f.selected || p.to === f.selected)) return true;
    if (p.rej) return f.type === 'rejected' || rejShown++ < 40;
    return i < f.limit;
  });
  const features = [];
  let rank = 0;
  for (const p of keep) {
    const a = pos(p.from), b = pos(p.to);
    if (!a || !b) continue;
    p.susp = p.head > 0 && p.susp_head / p.head >= 0.5 ? 1 : 0;
    p.rank = rank++;
    const long = Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) > 1;
    const { rej: _rej, ...props } = p;
    void _rej;
    features.push({
      type: 'Feature' as const,
      properties: props,
      geometry: { type: 'LineString' as const, coordinates: arc(a, b, p.rejected ? 0.32 : long ? 0.12 : 0.2, long ? 48 : 24) },
    });
  }
  return {
    fc: { type: 'FeatureCollection' as const, features },
    stats: { pairs: all.length, shown: features.length, totalHead, suspHead, nGta },
  };
}
