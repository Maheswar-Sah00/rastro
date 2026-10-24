import { useEffect, useRef, useState, type ReactNode } from 'react';

// Small interactive chart kit: HTML bars with rounded ends, one hover tooltip per chart,
// and a table view for every chart. Values reach the tooltip as React text (never HTML).

export const SERIES = { today: '#898781', rastro: '#3987e5' };
export const STATUS = { clean: '#0ca30c', watch: '#fab219', high: '#e5484d', unknown: '#6d746e' };

interface Tip { x: number; y: number; title: string; rows: { label: string; value: string; color?: string }[] }

function useInView<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [inView, setInView] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (!('IntersectionObserver' in window) || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return setInView(true);
    const io = new IntersectionObserver(([e]) => e.isIntersecting && (setInView(true), io.disconnect()), { threshold: 0.25 });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return [ref, inView] as const;
}

function useTip() {
  const box = useRef<HTMLDivElement>(null);
  const [tip, setTip] = useState<Tip | null>(null);
  const show = (e: { clientX: number; clientY: number } | HTMLElement, t: Omit<Tip, 'x' | 'y'>) => {
    const r = box.current?.getBoundingClientRect();
    if (!r) return;
    let cx: number, cy: number;
    if (e instanceof HTMLElement) {
      const b = e.getBoundingClientRect();
      cx = b.left + b.width / 2;
      cy = b.top;
    } else {
      cx = e.clientX;
      cy = e.clientY;
    }
    setTip({ ...t, x: Math.min(Math.max(cx - r.left, 90), r.width - 90), y: cy - r.top });
  };
  return { box, tip, show, hide: () => setTip(null) };
}

function TipBox({ tip }: { tip: Tip | null }) {
  if (!tip) return null;
  return (
    <div className="viz-tip" style={{ left: tip.x, top: tip.y }} role="status">
      <div className="viz-tip-title">{tip.title}</div>
      {tip.rows.map((r) => (
        <div className="viz-tip-row" key={r.label}>
          {r.color && <i style={{ background: r.color }} />}
          <b>{r.value}</b>
          <span>{r.label}</span>
        </div>
      ))}
    </div>
  );
}

/** Card with a title, an optional legend and a chart/table switch. */
export function ChartCard({ title, sub, legend, table, children, id, tag }: { title: string; sub?: ReactNode; legend?: { label: string; color: string }[]; table: ReactNode; children: ReactNode; id?: string; tag?: ReactNode }) {
  const [view, setView] = useState<'chart' | 'table'>('chart');
  return (
    <figure className="viz-card" id={id}>
      <figcaption className="viz-head">
        <div>
          <div className="viz-title">
            {title} {tag}
          </div>
          {sub && <div className="viz-sub">{sub}</div>}
        </div>
        <div className="viz-switch" role="group" aria-label="View">
          {(['chart', 'table'] as const).map((v) => (
            <button key={v} aria-pressed={view === v} onClick={() => setView(v)}>
              {v === 'chart' ? 'Chart' : 'Table'}
            </button>
          ))}
        </div>
      </figcaption>
      {legend && legend.length > 1 && view === 'chart' && (
        <div className="viz-legend">
          {legend.map((l) => (
            <span key={l.label}>
              <i style={{ background: l.color }} />
              {l.label}
            </span>
          ))}
        </div>
      )}
      {view === 'chart' ? children : <div className="viz-table-wrap">{table}</div>}
    </figure>
  );
}

export function DataTable({ head, rows }: { head: string[]; rows: (string | number)[][] }) {
  return (
    <table className="viz-table">
      <thead>
        <tr>
          {head.map((h, i) => (
            <th key={h} className={i ? 'r' : undefined}>
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={i}>
            {r.map((c, j) => (
              <td key={j} className={j ? 'r' : undefined}>
                {c}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Two series per row (today vs Rastro), horizontal, 0..max. */
export function PairBars({ rows, names = ['Today’s check', 'Rastro'], colors = [SERIES.today, SERIES.rastro], max = 100, unit = '%' }: {
  rows: { label: string; note?: string; a: number; b: number }[];
  names?: [string, string];
  colors?: [string, string];
  max?: number;
  unit?: string;
}) {
  const [ref, inView] = useInView<HTMLDivElement>();
  const { box, tip, show, hide } = useTip();
  const f = (v: number) => `${v % 1 ? v.toFixed(1) : v}${unit}`;
  return (
    <div ref={box} className="viz-plot" onPointerLeave={hide}>
      <div ref={ref} className={`pair-bars${inView ? ' in' : ''}`}>
        {rows.map((r) => (
          <div
            className="pair-row"
            key={r.label}
            tabIndex={0}
            onPointerMove={(e) => show(e, { title: r.label, rows: [{ label: names[1], value: f(r.b), color: colors[1] }, { label: names[0], value: f(r.a), color: colors[0] }] })}
            onFocus={(e) => show(e.currentTarget, { title: r.label, rows: [{ label: names[1], value: f(r.b), color: colors[1] }, { label: names[0], value: f(r.a), color: colors[0] }] })}
            onBlur={hide}
          >
            <div className="pair-label">
              {r.label}
              {r.note && <small>{r.note}</small>}
            </div>
            <div className="pair-tracks">
              {[r.b, r.a].map((v, i) => (
                <div className="pair-track" key={i}>
                  <span className="bar" style={{ width: `${(v / max) * 100}%`, background: colors[1 - i] }} />
                  <span className={`val${i ? ' dim' : ''}`}>{f(v)}</span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
      <TipBox tip={tip} />
    </div>
  );
}

/** Horizontal stacked bars; each segment hoverable. */
export function StackBars({ rows, keys, unit = '' }: { rows: { label: string; parts: Record<string, number> }[]; keys: { key: string; label: string; color: string }[]; unit?: string }) {
  const [ref, inView] = useInView<HTMLDivElement>();
  const { box, tip, show, hide } = useTip();
  const max = Math.max(1, ...rows.map((r) => keys.reduce((s, k) => s + (r.parts[k.key] ?? 0), 0)));
  return (
    <div ref={box} className="viz-plot" onPointerLeave={hide}>
      <div ref={ref} className={`stack-bars${inView ? ' in' : ''}`}>
        {rows.map((r) => {
          const total = keys.reduce((s, k) => s + (r.parts[k.key] ?? 0), 0);
          const t = { title: r.label, rows: keys.filter((k) => r.parts[k.key]).map((k) => ({ label: k.label, value: `${r.parts[k.key]}${unit}`, color: k.color })) };
          return (
            <div className="stack-row" key={r.label} tabIndex={0} onFocus={(e) => show(e.currentTarget, t)} onBlur={hide}>
              <div className="stack-label">{r.label}</div>
              <div className="stack-track">
                <div className="stack-fill" style={{ width: `${(total / max) * 100}%` }}>
                  {keys.map((k) =>
                    r.parts[k.key] ? (
                      <span key={k.key} style={{ flexGrow: r.parts[k.key], background: k.color }} onPointerMove={(e) => show(e, t)} />
                    ) : null,
                  )}
                </div>
                <span className="val">
                  {total}
                  {unit}
                </span>
              </div>
            </div>
          );
        })}
      </div>
      <TipBox tip={tip} />
    </div>
  );
}

/** Single-series horizontal bars. */
export function HBars({ rows, color, fmt: f = String }: { rows: { label: string; value: number; sub?: string }[]; color: string; fmt?: (v: number) => string }) {
  const [ref, inView] = useInView<HTMLDivElement>();
  const { box, tip, show, hide } = useTip();
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <div ref={box} className="viz-plot" onPointerLeave={hide}>
      <div ref={ref} className={`h-bars${inView ? ' in' : ''}`}>
        {rows.map((r) => {
          const t = { title: r.label, rows: [{ label: r.sub ?? '', value: f(r.value), color }] };
          return (
            <div className="h-row" key={r.label} tabIndex={0} onPointerMove={(e) => show(e, t)} onFocus={(e) => show(e.currentTarget, t)} onBlur={hide}>
              <div className="h-label">{r.label}</div>
              <div className="h-track">
                <span className="bar" style={{ width: `${(r.value / max) * 100}%`, background: color }} />
                <span className="val">{f(r.value)}</span>
              </div>
            </div>
          );
        })}
      </div>
      <TipBox tip={tip} />
    </div>
  );
}

/** Vertical columns over time, with an optional marker between two x values. */
export function Columns({ data, colorOf, fmt: f = String, marker, unit = '' }: {
  data: { x: number; y: number }[];
  colorOf: (x: number) => string;
  fmt?: (v: number) => string;
  marker?: { after: number; label: string };
  unit?: string;
}) {
  const [ref, inView] = useInView<HTMLDivElement>();
  const { box, tip, show, hide } = useTip();
  const [hover, setHover] = useState<number | null>(null);
  const rawMax = Math.max(1, ...data.map((d) => d.y));
  const step = niceStep(rawMax / 4);
  const max = Math.ceil(rawMax / step) * step;
  const ticks = Array.from({ length: Math.round(max / step) + 1 }, (_, i) => i * step);
  const peak = data.reduce((a, b) => (b.y > a.y ? b : a), data[0]);
  return (
    <div ref={box} className="viz-plot" onPointerLeave={() => (hide(), setHover(null))}>
      <div className="cols-wrap">
        <div className="cols-axis" aria-hidden>
          {ticks
            .slice()
            .reverse()
            .map((t) => (
              <span key={t}>{compact(t)}</span>
            ))}
        </div>
        <div ref={ref} className={`cols${inView ? ' in' : ''}`}>
          <div className="cols-grid" aria-hidden>
            {ticks.map((t) => (
              <i key={t} style={{ bottom: `${(t / max) * 100}%` }} />
            ))}
          </div>
          {data.map((d) => {
            const t = { title: String(d.x), rows: [{ label: unit, value: f(d.y), color: colorOf(d.x) }] };
            return (
              <div
                key={d.x}
                className={`col${hover === d.x ? ' hot' : ''}${marker && d.x === marker.after ? ' mark' : ''}`}
                tabIndex={0}
                onPointerMove={(e) => (show(e, t), setHover(d.x))}
                onFocus={(e) => (show(e.currentTarget, t), setHover(d.x))}
                onBlur={() => (hide(), setHover(null))}
              >
                <span className="bar" style={{ height: `${(d.y / max) * 100}%`, background: colorOf(d.x) }} />
                {d === peak && <span className="peak">{f(d.y)}</span>}
                <span className="x">{String(d.x).slice(2)}</span>
                {marker && d.x === marker.after && <span className="marker-label">{marker.label}</span>}
              </div>
            );
          })}
        </div>
      </div>
      <TipBox tip={tip} />
    </div>
  );
}

function niceStep(v: number) {
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  const n = v / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p;
}
export function compact(v: number) {
  return v >= 1000 ? `${(v / 1000).toFixed(v % 1000 ? 1 : 0)}K` : String(v);
}
