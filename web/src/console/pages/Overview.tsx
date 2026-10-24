import { api } from '../api/client';
import { riskMap, useAllRanches, useSummary } from '../api/hooks';
import type { ShipmentSummary } from '../api/types';
import { useApi } from '../api/useApi';
import { OutcomeBadge, RiskBadge } from '../components/Badges';
import { IdLink, Kpi, Section } from '../components/Evidence';
import { Async } from '../components/States';
import { DataTable, type Column } from '../components/Table';
import { MapCanvas, type LayerKey } from '../map/MapCanvas';
import { nf, num, pct } from '../lib/format';
import { href, navigate } from '../lib/router';

const MINI_LAYERS: Record<LayerKey, boolean> = { ranches: true, deforestation: true, cleared2008: false, indigenous: true, conservation: false, embargo: true, routes: false };

type Sum = {
  counts?: Record<string, number>;
  notice?: string;
  risk?: { decisions?: Record<string, number>; ranch_risk?: Record<string, number>; engine_version?: string } | null;
  lineage?: { review_required?: number; shipments?: number } | null;
  geospatial?: { ranches?: number; geometry_status?: Record<string, number>; eudr_indicator?: Record<string, number> } | null;
  evaluation?: string;
};

export function Overview() {
  const summary = useSummary();
  const ranches = useAllRanches();
  const flagged = useApi((s) => api.shipments({ outcome: 'FLAGGED', limit: 8 }, s), []);
  const review = useApi((s) => api.shipments({ outcome: 'REVIEW', limit: 8 }, s), []);

  return (
    <div className="page">
      <header className="page-head">
        <h1>Overview</h1>
        <p className="muted">All figures come from the API over the synthetic evaluation dataset (409 simulated ranches on real PRODES and FUNAI layers).</p>
      </header>
      <Async state={summary} what="Loading summary">
        {(raw) => {
          const s = raw as Sum;
          const d = s.risk?.decisions || {};
          const assessed = (d.PASS || 0) + (d.REVIEW || 0) + (d.FLAGGED || 0);
          const geo = s.geospatial;
          const measured = geo?.geometry_status?.valid ?? null;
          return (
            <>
              <div className="kpis">
                <Kpi label="Ranches monitored" value={nf.format(s.counts?.ranches ?? 0)} hint="Registry rows incl. suppliers outside the window" />
                <Kpi label="Cattle movements analysed" value={nf.format(s.counts?.gta_movements ?? 0)} hint="GTA permit records" />
                <Kpi label="Shipments assessed" value={s.risk ? `${nf.format(assessed)} / ${nf.format(s.counts?.shipments ?? 0)}` : 'not assessed'} />
                <Kpi label="Lots requiring review" value={s.risk ? nf.format(d.REVIEW || 0) : '—'} tone="amber" />
                <Kpi label="Flagged shipments" value={s.risk ? nf.format(d.FLAGGED || 0) : '—'} tone="red" />
                <Kpi
                  label="Environmental evidence coverage"
                  value={geo?.ranches ? pct((100 * (measured ?? 0)) / geo.ranches) : 'unavailable'}
                  hint="Ranches with a measurable geometry against the real layers"
                />
              </div>
              {s.notice && <div className="note">{s.notice}</div>}
            </>
          );
        }}
      </Async>
      <div className="grid-2">
        <Section title="Recent alerts: flagged shipments" aside={<a href={href('shipments', null, { outcome: 'FLAGGED' })}>All flagged</a>}>
          <Async state={flagged} what="Loading flagged shipments">
            {(p) => <ShipTable rows={p.data} compact />}
          </Async>
        </Section>
        <Section title="Review queue" aside={<a href={href('investigations')}>Investigations</a>}>
          <Async state={review} what="Loading review queue">
            {(p) => <ShipTable rows={p.data} compact />}
          </Async>
        </Section>
      </div>
      <div className="grid-2">
        <Section title="Geographic overview" aside={<a href={href('map')}>Open Live Map</a>}>
          <MapCanvas riskByRanch={riskMap(ranches.data?.data)} layers={MINI_LAYERS} compact onSelectRanch={(id) => navigate('ranches', id)} />
          <p className="small muted">Ranch cells are synthetic, coloured by risk-engine class; red hatch = active (simulated) embargo; clearing and protected areas are real.</p>
        </Section>
        <Section title="High-risk ranches">
          <Async state={ranches} what="Loading ranches">
            {(p) => (
              <DataTable
                rows={p.data.filter((r) => r.risk_class === 'high').slice(0, 10)}
                rowKey={(r) => r.ranch_id}
                onRow={(r) => navigate('ranches', r.ranch_id)}
                columns={[
                  { key: 'id', header: 'Ranch', render: (r) => <IdLink id={r.ranch_id} /> },
                  { key: 'role', header: 'Role', render: (r) => r.role },
                  { key: 'defo', header: 'Post-cut-off clearing', align: 'right', render: (r) => (r.post_cutoff_deforestation_ha === null ? '— not measured' : `${num(r.post_cutoff_deforestation_ha, 1)} ha`) },
                  { key: 'risk', header: 'Risk', render: (r) => <RiskBadge risk={r.risk_class} assessed={r.risk_status === 'assessed'} /> },
                ]}
              />
            )}
          </Async>
        </Section>
      </div>
    </div>
  );
}

export function ShipTable({ rows, compact }: { rows: ShipmentSummary[]; compact?: boolean }) {
  const hidden = compact ? new Set(['dest', 'cov']) : new Set<string>();
  return (
    <DataTable
      rows={rows}
      rowKey={(r) => r.shipment_id}
      onRow={(r) => navigate('shipments', r.shipment_id)}
      columns={([
        { key: 'id', header: 'Shipment', render: (r) => <a className="mono" href={href('shipments', r.shipment_id)}>{r.shipment_id}</a> },
        { key: 'date', header: 'Date', render: (r) => r.shipment_date },
        { key: 'dest', header: 'Destination', render: (r) => <span className="mono">{r.destination_id}</span> },
        { key: 'head', header: 'Head', align: 'right', render: (r) => nf.format(r.declared_head_count) },
        { key: 'risk', header: 'Risky / unknown', align: 'right', render: (r) => pct(r.any_risk_pct) },
        { key: 'cov', header: 'Coverage', align: 'right', render: (r) => pct(r.coverage_pct) },
        { key: 'out', header: 'Decision', render: (r) => <OutcomeBadge outcome={r.assessment_status === 'assessed' ? r.outcome : null} /> },
      ] satisfies Column<ShipmentSummary>[]).filter((c) => !hidden.has(c.key))}
    />
  );
}
