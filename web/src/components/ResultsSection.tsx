import { useMemo, useRef, useState } from 'react';
import { useData } from '../lib/data';
import { ChartCard, DataTable, PairBars, SERIES, STATUS, StackBars } from './charts';
import { useNear } from './MapSection';
import { SourceTag } from './Tags';

const MARKET: Record<string, string> = { EG: 'Egypt', IQ: 'Iraq', JO: 'Jordan', LB: 'Lebanon', MA: 'Morocco', SA: 'Saudi Arabia', TR: 'Türkiye', EU: 'EU' };
const VERDICT = [
  { key: 'fail', label: 'Rastro: fail', color: STATUS.high },
  { key: 'review', label: 'Rastro: review', color: STATUS.watch },
  { key: 'pass', label: 'Rastro: pass', color: STATUS.clean },
];

export function ResultsSection() {
  const metrics = useData('metrics');
  const m = metrics.data;
  const [run, setRun] = useState<'base' | 'stress'>('base');
  const ref = useRef<HTMLElement>(null);
  const near = useNear(ref, '600px');
  const ships = useData('shipments', near);
  const tag = <SourceTag kind={metrics.origin === 'mock' ? 'mock' : 'synthetic'} title="Measured on the simulated supply chain against its ground truth" />;

  const block = run === 'stress' && m?.stress_test ? m.stress_test : m?.eval;
  const rows = block
    ? [
        { label: 'Tainted head caught', note: 'higher is better', a: block.status_quo.tainted_head_caught_pct ?? 0, b: block.rastro.tainted_head_caught_pct ?? 0 },
        {
          label: 'Dirty sources found',
          note: 'higher is better',
          a: pctOf(block.status_quo.dirty_sources_found, block.status_quo.dirty_sources_total),
          b: pctOf(block.rastro.dirty_sources_found, block.rastro.dirty_sources_total),
        },
        { label: 'Clean lots blocked', note: 'lower is better', a: block.status_quo.clean_lots_failed_pct ?? 0, b: block.rastro.clean_lots_failed_pct ?? 0 },
      ]
    : [];

  const markets = useMemo(() => {
    const list = (ships.data ?? []).filter((s) => s.kind === 'voyage');
    const by = new Map<string, Record<string, number>>();
    for (const s of list) {
      const k = s.market;
      const r = by.get(k) ?? { fail: 0, review: 0, pass: 0 };
      r[s.rastro_verdict === 'fail' ? 'fail' : s.rastro_verdict === 'review' ? 'review' : 'pass']++;
      by.set(k, r);
    }
    const sqPass = list.filter((s) => s.status_quo_verdict === 'pass').length;
    return {
      total: list.length,
      sqPass,
      rows: [...by.entries()]
        .map(([k, parts]) => ({ label: MARKET[k] ?? k, parts }))
        .sort((a, b) => sum(b.parts) - sum(a.parts)),
    };
  }, [ships.data]);

  return (
    <section id="results" ref={ref} className="section" aria-labelledby="results-title">
      <div className="wrap">
        <div className="section-head center">
          <p className="kicker">03 · Results</p>
          <h2 className="title" id="results-title">
            Same permits. Far more caught.
          </h2>
        </div>

        <div className="viz-filters" role="group" aria-label="Evaluation run">
          <button aria-pressed={run === 'base'} onClick={() => setRun('base')}>
            Normal launderers
          </button>
          <button aria-pressed={run === 'stress'} onClick={() => setRun('stress')} disabled={!m?.stress_test}>
            Red team: patient, two hops
          </button>
          <span className="viz-filters-note">
            {block && 'lots' in block && block.lots ? `${block.lots.toLocaleString('en')} lots scored` : ''}
          </span>
        </div>

        <div className="viz-grid">
          <ChartCard
            id="how-eval"
            title="Today's check vs Rastro"
            sub="Share of each, on the simulated Pará supply chain"
            tag={tag}
            legend={[
              { label: 'Rastro', color: SERIES.rastro },
              { label: "Today's check", color: SERIES.today },
            ]}
            table={<DataTable head={['Metric', "Today's check", 'Rastro']} rows={rows.map((r) => [r.label, `${r.a.toFixed(1)}%`, `${r.b.toFixed(1)}%`])} />}
          >
            {rows.length ? <PairBars rows={rows} /> : <p className="viz-empty">Metrics not available yet.</p>}
          </ChartCard>

          <ChartCard
            title="Live-export voyages"
            sub={markets.total ? `${markets.sqPass} of ${markets.total} pass today's check` : 'From Barcarena, by destination'}
            tag={<SourceTag kind={ships.origin === 'mock' ? 'mock' : 'synthetic'} />}
            legend={VERDICT}
            table={<DataTable head={['Market', 'Fail', 'Review', 'Pass']} rows={markets.rows.map((r) => [r.label, r.parts.fail, r.parts.review, r.parts.pass])} />}
          >
            {markets.rows.length ? <StackBars rows={markets.rows} keys={VERDICT} /> : <p className="viz-empty">{ships.status === 'loading' ? 'Loading voyages…' : 'No voyages in the dataset.'}</p>}
          </ChartCard>
        </div>
      </div>
    </section>
  );
}

function pctOf(a?: number, b?: number) {
  return a != null && b ? Math.round((a / b) * 1000) / 10 : 0;
}
function sum(r: Record<string, number>) {
  return Object.values(r).reduce((a, b) => a + b, 0);
}
