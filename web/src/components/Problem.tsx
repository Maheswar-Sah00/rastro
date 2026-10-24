import { useMemo, useRef } from 'react';
import { useData } from '../lib/data';
import { CONTEXT_STATS } from '../lib/content';
import { fmt } from '../lib/format';
import { ChartCard, Columns, DataTable } from './charts';
import { useNear } from './MapSection';
import { SourceTag } from './Tags';

const PRE = '#6d746e';
const POST = '#e5484d';

export function Problem() {
  const meta = useData('meta');
  const ref = useRef<HTMLElement>(null);
  const near = useNear(ref, '600px');
  const defor = useData('deforestation', near);
  const metrics = useData('metrics');
  const byYear = useMemo(() => {
    const m = new Map<number, number>();
    for (const f of defor.data?.features ?? []) if (f.properties.year) m.set(f.properties.year, (m.get(f.properties.year) ?? 0) + f.properties.area_ha);
    return [...m.entries()].sort((a, b) => a[0] - b[0]).map(([x, y]) => ({ x, y: Math.round(y) }));
  }, [defor.data]);
  const post = byYear.filter((d) => d.x > 2020).reduce((s, d) => s + d.y, 0);
  const metricsMock = metrics.origin === 'mock';

  return (
    <section id="problem" ref={ref} className="section" aria-labelledby="problem-title">
      <div className="wrap">
        <div className="section-head center">
          <p className="kicker">01 · The problem</p>
          <h2 className="title" id="problem-title">
            Buyers check one hop. <em>Laundering happens two hops up.</em>
          </h2>
        </div>

        <div className="problem-viz">
          <div className="viz-card blind">
            <BlindSpot />
          </div>
          <ChartCard
            title="Forest cleared in the study area"
            sub={post ? `${fmt(post)} ha after the EUDR cut-off` : 'PRODES, hectares per year'}
            tag={<SourceTag kind={defor.origin === 'mock' ? 'mock' : 'real'} title="INPE PRODES deforestation polygons" />}
            legend={[
              { label: 'After 2020', color: POST },
              { label: 'Up to 2020', color: PRE },
            ]}
            table={<DataTable head={['Year', 'Hectares']} rows={byYear.map((d) => [d.x, fmt(d.y)])} />}
          >
            {byYear.length ? (
              <Columns data={byYear} colorOf={(x) => (x > 2020 ? POST : PRE)} fmt={(v) => `${fmt(v)} ha`} unit="cleared" marker={{ after: 2020, label: 'EUDR cut-off' }} />
            ) : (
              <p className="viz-empty">{defor.status === 'loading' ? 'Loading PRODES…' : 'Deforestation layer unavailable.'}</p>
            )}
          </ChartCard>
        </div>

        <div className="tiles" role="list">
          {CONTEXT_STATS.map((s) => (
            <article className="tile" role="listitem" key={s.value}>
              <span className="tile-value">{s.value}</span>
              <span className="tile-text">{TILE_TEXT[s.value] ?? s.text}</span>
              <a className="tile-src" href={s.sources[0].url} target="_blank" rel="noreferrer" title={s.text}>
                {s.sources[0].label} ↗
              </a>
            </article>
          ))}
        </div>

        <div className="legend-strip" aria-label="Data legend">
          <span>
            <SourceTag kind="real" /> land, clearings, protected areas, herd totals
          </span>
          <span>
            <SourceTag kind="synthetic" /> ranches, herds, permits, buyers
          </span>
          {(meta.origin === 'mock' || metricsMock) && (
            <span>
              <SourceTag kind="mock" /> preview data
            </span>
          )}
        </div>
      </div>
    </section>
  );
}

const TILE_TEXT: Record<string, string> = {
  '2030': 'Pará delays tagging every animal',
  '30 Dec 2026': 'EU deforestation rules reach beef',
  '64.5%': "of Brazil's live-cattle exports leave Pará",
};


function Herd({ cx, cy, color }: { cx: number; cy: number; color: string }) {
  return (
    <g aria-hidden>
      {[-24, -12, 0, 12, 24].map((dx, i) => (
        <circle key={dx} cx={cx + dx} cy={cy + (i % 2 ? -4 : 3)} r="4.4" fill={color} />
      ))}
    </g>
  );
}

/** The laundering pattern, and what each check can see. */
function BlindSpot() {
  const node = (x: number, title: string, lines: string[], stroke: string, fill: string, ink: string, herd?: string) => (
    <g>
      <rect x={x} y="56" width="128" height="120" rx="18" style={{ fill, stroke }} strokeWidth="1.6" />
      <text x={x + 64} y="84" textAnchor="middle" fontSize="13.5" fontWeight="700" style={{ fill: ink }}>
        {title}
      </text>
      {lines.map((l, i) => (
        <text key={l} x={x + 64} y={106 + i * 16} textAnchor="middle" fontSize="11.5" style={{ fill: ink }} opacity="0.8">
          {l}
        </text>
      ))}
      {herd && <Herd cx={x + 64} cy={154} color={herd} />}
    </g>
  );
  return (
    <svg viewBox="0 0 460 290" role="img" aria-labelledby="bs-title bs-desc" className="blind-svg">
      <title id="bs-title">How cattle laundering hides from today's checks</title>
      <desc id="bs-desc">
        Animals from a ranch with illegal clearing move to a clean-looking intermediary, which resells them to a buyer. Today's check covers only the
        last hop. Rastro covers the whole path.
      </desc>
      <defs>
        <marker id="arr" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M1,1 L9,5 L1,9" fill="none" style={{ stroke: 'var(--muted)' }} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </marker>
      </defs>
      <path d="M18 36 V30 Q18 20 28 20 H432 Q442 20 442 30 V36" fill="none" style={{ stroke: 'var(--accent)' }} strokeWidth="2" strokeLinecap="round" />
      <text x="230" y="12" textAnchor="middle" fontSize="12" fontWeight="700" style={{ fill: 'var(--accent-2)' }} letterSpacing="1">
        RASTRO CHECKS THE WHOLE PATH
      </text>
      {node(18, 'Origin ranch', ['post-2020 clearing,', 'Indigenous land'], 'var(--high)', 'var(--high-tint)', 'var(--high-ink)', 'var(--high)')}
      {node(166, 'Intermediary', ['resells in 9 days', '"looks clean"'], 'var(--watch)', 'var(--watch-tint)', 'var(--watch-ink)', 'var(--high)')}
      {node(314, 'Buyer', ['slaughterhouse or', 'ship to Türkiye'], 'var(--rule-2)', 'var(--surface-2)', 'var(--ink)')}
      <line x1="149" y1="116" x2="162" y2="116" style={{ stroke: 'var(--muted)' }} strokeWidth="1.8" strokeLinecap="round" markerEnd="url(#arr)" />
      <line x1="297" y1="116" x2="310" y2="116" style={{ stroke: 'var(--muted)' }} strokeWidth="1.8" strokeLinecap="round" markerEnd="url(#arr)" />
      <rect x="158" y="206" width="292" height="50" rx="25" fill="none" style={{ stroke: 'var(--muted)' }} strokeWidth="1.4" strokeDasharray="5 5" />
      <text x="304" y="228" textAnchor="middle" fontSize="12" fontWeight="700" style={{ fill: 'var(--ink-2)' }}>
        Today's check: last hop only
      </text>
      <text x="304" y="245" textAnchor="middle" fontSize="11" style={{ fill: 'var(--muted)' }}>
        intermediary passes → "clean"
      </text>
      <path d="M230 202 V180" style={{ stroke: 'var(--muted)' }} strokeWidth="1.4" strokeDasharray="3 4" strokeLinecap="round" />
      <text x="82" y="228" textAnchor="middle" fontSize="12" fontWeight="700" style={{ fill: 'var(--high-ink)' }}>
        Never checked
      </text>
      <text x="82" y="245" textAnchor="middle" fontSize="11" style={{ fill: 'var(--high-ink)' }} opacity="0.8">
        by the buyer
      </text>
      <path d="M82 202 V180" style={{ stroke: 'var(--high)' }} strokeWidth="1.4" strokeDasharray="3 4" strokeLinecap="round" />
    </svg>
  );
}
