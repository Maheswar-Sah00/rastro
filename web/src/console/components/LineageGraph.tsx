import { useMemo, useState } from 'react';
import type { DrawEdge, DrawGraph, DrawNode } from '../lib/graph';
import { highlightPaths, isUnknownNode } from '../lib/graph';
import { label, num, pct } from '../lib/format';

const W = 980;
const NODE_W = 14;
const GAP = 8;

export interface GraphSelection { node?: DrawNode; edge?: DrawEdge }

/** Layered lineage graph (SVG): origins on the left, the destination on the right. Band widths follow the API's attributed head. */
export function LineageGraphView({ graph, category, onSelect }: { graph: DrawGraph; category: string | null; onSelect: (s: GraphSelection) => void }) {
  const lit = useMemo(() => highlightPaths(graph, category), [graph, category]);
  const [hover, setHover] = useState<{ x: number; y: number; text: string } | null>(null);
  const g = graph;

  const cols = Math.max(2, g.layers);
  const colX = (l: number) => 20 + (l * (W - 40 - NODE_W)) / (cols - 1);
  const byLayer = new Map<number, DrawNode[]>();
  for (const n of g.nodes) byLayer.set(n.layer, [...(byLayer.get(n.layer) || []), n]);
  const size = (n: DrawNode) => Math.max(n.inHead, n.outHead, n.head, 1);
  const colTotals = [...byLayer.values()].map((ns) => ns.reduce((s, n) => s + size(n), 0));
  const maxCount = Math.max(...[...byLayer.values()].map((ns) => ns.length));
  const H = Math.max(340, Math.min(1100, 40 + maxCount * 22));
  const k = (H - 40 - GAP * maxCount) / Math.max(...colTotals, 1);
  const pos = new Map<string, { x: number; y: number; h: number }>();
  for (const [l, ns] of byLayer) {
    let y = 20;
    ns.sort((a, b) => size(b) - size(a) || a.id.localeCompare(b.id));
    for (const n of ns) {
      const h = Math.max(3, size(n) * k);
      pos.set(n.id, { x: colX(l), y, h });
      y += h + GAP;
    }
  }
  const outOff = new Map<string, number>();
  const inOff = new Map<string, number>();
  const bands = g.edges
    .filter((e) => !e.back)
    .sort((a, b) => b.head - a.head)
    .flatMap((e) => {
      const s = pos.get(e.source);
      const t = pos.get(e.target);
      if (!s || !t) return [];
      const w = Math.max(1, e.head * k);
      const so = outOff.get(e.source) || 0;
      const to = inOff.get(e.target) || 0;
      outOff.set(e.source, so + w);
      inOff.set(e.target, to + w);
      const x0 = s.x + NODE_W, y0 = s.y + so + w / 2, x1 = t.x, y1 = t.y + to + w / 2, mx = (x0 + x1) / 2;
      return [{ e, d: `M${x0},${y0} C${mx},${y0} ${mx},${y1} ${x1},${y1}`, w }];
    });

  return (
    <div className="graph">
      <div className="graph-tools small">
        <span>
          {g.nodes.length} nodes · {g.edges.filter((e) => !e.back).length} links · {g.layers} columns
          {g.removedBackEdges > 0 && ` · ${g.removedBackEdges} back-and-forth link(s) not drawn (cattle moved both ways between two places)`}
        </span>
        <span className="legend-inline">
          {LEGEND.map(([c, t]) => (
            <span key={t}>
              <i style={{ background: c }} /> {t}
            </span>
          ))}
        </span>
      </div>
      <div className="graph-scroll">
        <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label="Lineage graph from origin ranches through intermediaries to the destination">
          {bands.map(({ e, d, w }, i) => (
            <path
              key={i}
              d={d}
              fill="none"
              stroke={category && lit.has(e) ? '#e5484d' : e.kind === 'folded' ? 'rgba(255,255,255,.16)' : 'rgba(255,255,255,.30)'}
              strokeOpacity={category ? (lit.has(e) ? 0.8 : 0.12) : 0.5}
              strokeWidth={w}
              tabIndex={0}
              aria-label={edgeText(e)}
              onClick={() => onSelect({ edge: e })}
              onKeyDown={(ev) => ev.key === 'Enter' && onSelect({ edge: e })}
              onMouseMove={(ev) => setHover({ x: ev.nativeEvent.offsetX, y: ev.nativeEvent.offsetY, text: edgeText(e) })}
              onMouseLeave={() => setHover(null)}
            />
          ))}
          {g.nodes.map((n) => {
            const p = pos.get(n.id)!;
            const right = p.x > W / 2;
            return (
              <g key={n.id}>
                <rect
                  x={p.x}
                  y={p.y}
                  width={NODE_W}
                  height={p.h}
                  fill={fill(n)}
                  rx={2}
                  tabIndex={0}
                  className="graph-node"
                  aria-label={nodeText(n)}
                  onClick={() => onSelect({ node: n })}
                  onKeyDown={(ev) => ev.key === 'Enter' && onSelect({ node: n })}
                  onMouseMove={(ev) => setHover({ x: ev.nativeEvent.offsetX, y: ev.nativeEvent.offsetY, text: nodeText(n) })}
                  onMouseLeave={() => setHover(null)}
                />
                {p.h >= 8 && (
                  <text x={right ? p.x - 4 : p.x + NODE_W + 4} y={p.y + p.h / 2} dy="0.35em" textAnchor={right ? 'end' : 'start'} className="graph-label">
                    {n.label}
                  </text>
                )}
              </g>
            );
          })}
        </svg>
        {hover && (
          <div className="map-hover" style={{ left: hover.x + 12, top: hover.y + 12 }}>
            {hover.text}
          </div>
        )}
      </div>
    </div>
  );
}

const LEGEND: [string, string][] = [
  ['#e5484d', 'environmental risk'],
  ['#fab219', 'births / inventory'],
  ['#898781', 'unknown origin'],
  ['#0ca30c', 'no category'],
  ['#6f7a72', 'grouped'],
  ['#3987e5', 'destination'],
];

export function fill(n: DrawNode) {
  if (n.kind === 'destination') return '#3987e5';
  if (isUnknownNode(n)) return '#898781';
  if (n.categories.some((x) => ['post_cutoff_deforestation', 'embargo', 'indigenous_territory', 'protected_area', 'protected_overlap'].includes(x))) return '#e5484d';
  if (n.categories.some((x) => /birth|inventory/.test(x))) return '#fab219';
  if (n.kind === 'folded') return '#6f7a72';
  return '#0ca30c';
}

export function nodeText(n: DrawNode) {
  const parts = [`${n.label} · ${label(n.kind)}`];
  if (n.head > 0) parts.push(`origin of ${num(n.head, 1)} head, ${pct(n.share_pct)} (FIFO estimate); pro-rata ${num(n.headProRata, 1)} head`);
  else if (n.kind !== 'destination') parts.push('pass-through only (not an origin under FIFO)');
  if (n.categories.length) parts.push(n.categories.map(label).join(', '));
  if (n.kind === 'folded') parts.push(`${n.members.length} grouped origins: click to list and expand`);
  return parts.join(' · ');
}

export function edgeText(e: DrawEdge) {
  const what = e.kind === 'folded' ? `${e.gta_count ?? '?'} grouped permits` : e.gta_id || label(e.kind);
  return `${e.source} → ${e.target} · ${num(e.head, 1)} head attributed to this lot of ${num(e.permit_head)} on the permit · ${what}${e.date ? ` · ${e.date}` : ''}`;
}
