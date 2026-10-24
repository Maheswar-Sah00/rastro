import { useEffect, useMemo, useRef, useState } from 'react';
import { sankey, sankeyLinkHorizontal, type SankeyGraph, type SankeyLink, type SankeyNode } from 'd3-sankey';
import type { DerivedTrace, TLink, TNode } from '../lib/trace';
import { RISK_COLOR } from '../lib/colors';
import { fmt } from '../lib/format';

type N = SankeyNode<TNode, TLink>;
type L = SankeyLink<TNode, TLink>;

const ORDER: Record<string, number> = { high: 0, watch: 1, unknown: 2, other: 3, clean: 4, shipment: 5 };
const sortKey = (n: TNode) => (ORDER[n.cls] ?? 9) * 2 + (n.kind === 'other' ? 1 : 0);
const nodeColor = (n: TNode) => (n.cls === 'shipment' ? 'var(--ink)' : RISK_COLOR[n.cls] ?? RISK_COLOR.other);

export function Sankey({ trace, onNode }: { trace: DerivedTrace; onNode: (ranchId: string) => void }) {
  const wrap = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(900);
  const [hover, setHover] = useState<{ kind: 'node' | 'link'; id: string } | null>(null);
  const [tip, setTip] = useState<{ x: number; y: number; html: React.ReactNode } | null>(null);

  useEffect(() => {
    if (!wrap.current) return;
    const ro = new ResizeObserver((es) => setWidth(Math.max(300, Math.floor(es[0].contentRect.width))));
    ro.observe(wrap.current);
    return () => ro.disconnect();
  }, []);

  const narrow = width < 640;
  const colsUsed = useMemo(() => [...new Set(trace.nodes.map((n) => n.col))].sort((a, b) => a - b), [trace]);
  const colIndex = useMemo(() => new Map(colsUsed.map((c, i) => [c, i])), [colsUsed]);
  const maxPerCol = useMemo(() => {
    const m = new Map<number, number>();
    trace.nodes.forEach((n) => m.set(n.col, (m.get(n.col) ?? 0) + 1));
    return Math.max(1, ...m.values());
  }, [trace]);
  const height = Math.max(trace.nodes.length <= 3 ? 170 : 260, Math.min(720, maxPerCol * (narrow ? 26 : 30) + 40));
  const margin = narrow ? { l: 78, r: 70 } : { l: 170, r: 150 };

  const graph = useMemo(() => {
    const nodes = trace.nodes.map((n) => ({ ...n, col: colIndex.get(n.col) ?? 0 }));
    const ids = new Set(nodes.map((n) => n.id));
    const links = trace.links.filter((l) => ids.has(l.source) && ids.has(l.target) && l.value > 0).map((l) => ({ ...l }));
    if (!links.length) return null;
    const gen = sankey<TNode, TLink>()
      .nodeId((d) => d.id)
      .nodeAlign((n) => (n as unknown as TNode).col)
      .nodeWidth(narrow ? 10 : 13)
      .nodePadding(narrow ? 6 : 8)
      .nodeSort((a, b) => sortKey(a) - sortKey(b) || (b.value ?? 0) - (a.value ?? 0))
      .extent([
        [margin.l, 26],
        [width - margin.r, height - 8],
      ]);
    try {
      return gen({ nodes, links } as unknown as SankeyGraph<TNode, TLink>);
    } catch {
      return null;
    }
  }, [trace, width, height, narrow, colIndex, margin.l, margin.r]);

  if (!graph) return <div className="empty">No upstream flow to draw for this shipment.</div>;
  const path = sankeyLinkHorizontal<TNode, TLink>();
  const nCols = colsUsed.length;
  const colX = (i: number) => {
    const ns = (graph.nodes as N[]).filter((n) => (n as unknown as TNode).col === i);
    return ns.length ? (ns[0].x0 ?? 0) : 0;
  };
  const directCol = colsUsed.findIndex((c) => trace.nodes.some((n) => n.col === c && n.kind === 'direct'));
  const isLinked = (l: L) => {
    if (!hover) return true;
    const s = l.source as N, t = l.target as N;
    if (hover.kind === 'link') return `${s.id}|${t.id}` === hover.id;
    return s.id === hover.id || t.id === hover.id;
  };
  const showTip = (e: React.MouseEvent, html: React.ReactNode) => {
    const r = wrap.current?.getBoundingClientRect();
    if (!r) return;
    setTip({ x: e.clientX - r.left + 12, y: e.clientY - r.top + 12, html });
  };

  return (
    <div ref={wrap} style={{ position: 'relative' }}>
      <svg className="sankey-svg" width={width} height={height} role="img" aria-label="Upstream flow of cattle into this shipment">
        {directCol >= 0 && (
          <g>
            <rect x={colX(directCol) - 8} y={18} width={(narrow ? 10 : 13) + 16 + (narrow ? 52 : 90)} height={height - 22} rx={16} style={{ fill: 'rgba(var(--fg-rgb),0.03)', stroke: 'var(--rule-2)' }} strokeDasharray="5 5" strokeLinecap="round" />
          </g>
        )}
        {colsUsed.map((c, i) => {
          const kind = trace.nodes.find((n) => n.col === c)?.kind;
          const label = kind === 'ship' ? 'Shipment' : kind === 'direct' ? (narrow ? "Today's check" : "Direct suppliers · today's check") : kind === 'hop' ? `${nCols - 1 - i} hops up` : narrow ? 'Origins' : 'Where they were raised';
          const x = colX(i);
          const leftEdge = i === 0 && kind !== 'direct' && kind !== 'ship';
          const anchor = leftEdge ? 'end' : 'start';
          return (
            <text key={c} x={leftEdge ? x + (narrow ? 10 : 13) : kind === 'direct' ? x - 4 : x} y={12} textAnchor={anchor} fontSize={10.5} fontFamily="var(--mono)" letterSpacing="0.08em" style={{ fill: 'var(--muted)' }}>
              {label.toUpperCase()}
            </text>
          );
        })}
        <g fill="none">
          {(graph.links as L[]).map((l, i) => {
            const s = l.source as N, t = l.target as N;
            const on = isLinked(l);
            const color = RISK_COLOR[(l as unknown as TLink).cls] ?? RISK_COLOR.other;
            return (
              <path
                key={i}
                d={path(l) ?? undefined}
                stroke={color}
                strokeOpacity={hover ? (on ? 0.62 : 0.06) : 0.32}
                strokeWidth={Math.max(1, l.width ?? 1)}
                onMouseEnter={(e) => {
                  setHover({ kind: 'link', id: `${s.id}|${t.id}` });
                  showTip(e, (
                    <>
                      <b>{s.label}</b> → <b>{t.label}</b>
                      <div>{fmt(l.value, l.value < 10 ? 1 : 0)} head-equivalent</div>
                    </>
                  ));
                }}
                onMouseMove={(e) => tip && showTip(e, tip.html)}
                onMouseLeave={() => {
                  setHover(null);
                  setTip(null);
                }}
                style={{ transition: 'stroke-opacity .15s' }}
              />
            );
          })}
        </g>
        <g>
          {(graph.nodes as N[]).map((n) => {
            const x0 = n.x0 ?? 0, x1 = n.x1 ?? 0, y0 = n.y0 ?? 0, y1 = n.y1 ?? 0;
            const h = Math.max(1, y1 - y0);
            const col = (n as unknown as TNode).col;
            const left = col === 0 && nCols > 1 && n.kind !== 'direct';
            const isShip = n.kind === 'ship';
            const clickable = !!n.ranchId;
            const lx = left ? x0 - 6 : x1 + 6;
            const showSub = h >= 22 && !narrow;
            return (
              <g
                key={n.id}
                style={{ cursor: clickable ? 'pointer' : 'default' }}
                onClick={() => n.ranchId && onNode(n.ranchId)}
                onMouseEnter={(e) => {
                  setHover({ kind: 'node', id: n.id });
                  showTip(e, (
                    <>
                      <b>{n.label}</b> <span style={{ opacity: 0.75 }}>{n.sub}</span>
                      <div>{fmt(n.value ?? 0)} head-equivalent</div>
                      {clickable && <div style={{ opacity: 0.75 }}>Click to open the ranch</div>}
                    </>
                  ));
                }}
                onMouseLeave={() => {
                  setHover(null);
                  setTip(null);
                }}
                tabIndex={clickable ? 0 : -1}
                role={clickable ? 'button' : undefined}
                aria-label={clickable ? `${n.label}, ${n.sub}, ${fmt(n.value ?? 0)} head` : undefined}
                onKeyDown={(e) => {
                  if ((e.key === 'Enter' || e.key === ' ') && n.ranchId) onNode(n.ranchId);
                }}
              >
                <rect x={x0} y={y0} width={x1 - x0} height={h} style={{ fill: nodeColor(n) }} rx={3} />
                {n.kind === 'other' && <rect x={x0} y={y0} width={x1 - x0} height={h} fill="url(#sk-hatch)" rx={2} />}
                {isShip ? (
                  <text x={x1 + 8} y={(y0 + y1) / 2} dy="0.35em" fontSize={narrow ? 12 : 14} fontWeight={700} style={{ fill: 'var(--ink)' }}>
                    {n.label}
                    {!narrow && (
                      <tspan x={x1 + 8} dy="1.3em" fontSize={12} fontWeight={500} style={{ fill: 'var(--muted)' }}>
                        {n.sub}
                      </tspan>
                    )}
                  </text>
                ) : (
                  <text x={lx} y={(y0 + y1) / 2} dy={showSub ? '-0.15em' : '0.35em'} textAnchor={left ? 'end' : 'start'} fontSize={narrow ? 10.5 : 12} fontWeight={600} style={{ fill: 'var(--ink)' }} fontFamily={n.ranchId ? 'var(--mono)' : undefined}>
                    {n.label}
                    {showSub && (
                      <tspan x={lx} dy="1.25em" fontSize={11} fontWeight={400} style={{ fill: 'var(--muted)' }} fontFamily="var(--sans)">
                        {n.sub}
                      </tspan>
                    )}
                  </text>
                )}
              </g>
            );
          })}
        </g>
        <defs>
          <pattern id="sk-hatch" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <line x1="0" y1="0" x2="0" y2="5" stroke="rgba(255,255,255,0.55)" strokeWidth="2" />
          </pattern>
        </defs>
      </svg>
      {tip && (
        <div className="sankey-tip" style={{ left: Math.min(tip.x, width - 200), top: tip.y }}>
          {tip.html}
        </div>
      )}
    </div>
  );
}
