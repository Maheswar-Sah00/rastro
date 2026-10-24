import { useMemo, useState } from 'react';
import { api } from '../api/client';
import type { MovementView, RanchSummary } from '../api/types';
import { useApi } from '../api/useApi';
import { ProvenanceLabel, RiskBadge, Tag } from '../components/Badges';
import { EvidenceCard, FindingList, IdLink, KV, Section } from '../components/Evidence';
import { FilterPanel, SelectFilter, TextFilter } from '../components/Filters';
import { Async } from '../components/States';
import { DataTable, Pagination } from '../components/Table';
import { ha, label, nf, num } from '../lib/format';
import { href, navigate, setQuery, type Route } from '../lib/router';

const PAGE = 25;

export function Ranches({ route }: { route: Route }) {
  if (route.id) return <RanchPage id={route.id} />;
  return <RanchList route={route} />;
}

function RanchList({ route }: { route: Route }) {
  const q = route.query;
  const role = q.get('role') || '';
  const risk = q.get('risk') || '';
  const env = q.get('env') || '';
  const text = q.get('q') || '';
  const offset = Number(q.get('offset') || 0);
  // Role and risk are server-side filters; text and evidence status filter the returned page set.
  const state = useApi((s) => api.ranches({ role: role || undefined, risk_class: risk || undefined, limit: 500 }, s), [role, risk]);
  const rows = useMemo(() => {
    const all = state.data?.data || [];
    return all.filter(
      (r) => (!text || r.ranch_id.includes(text.toUpperCase()) || r.display_name.toLowerCase().includes(text.toLowerCase())) && (!env || r.environmental_evidence === env),
    );
  }, [state.data, text, env]);

  return (
    <div className="page">
      <header className="page-head">
        <h1>Ranches</h1>
        <p className="muted">
          Synthetic ranch registry. Environmental columns come from the geospatial engine on real layers; “—” means not measured, never “none”.
        </p>
      </header>
      <FilterPanel onReset={() => navigate('ranches')}>
        <TextFilter label="Search" value={text} onChange={(v) => setQuery(route, { q: v, offset: null })} placeholder="R0120 or name" />
        <SelectFilter label="Role" value={role} onChange={(v) => setQuery(route, { role: v, offset: null })}
          options={['breeder', 'rearer', 'fattener', 'intermediary', 'external'].map((v) => ({ value: v, label: v }))} />
        <SelectFilter label="Risk class" value={risk} onChange={(v) => setQuery(route, { risk: v, offset: null })}
          options={['high', 'watch', 'clean', 'insufficient_data'].map((v) => ({ value: v, label: label(v) }))} />
        <SelectFilter label="Environmental evidence" value={env} onChange={(v) => setQuery(route, { env: v, offset: null })}
          options={[{ value: 'available', label: 'available' }, { value: 'missing', label: 'missing' }, { value: 'not_applicable', label: 'outside window' }]} />
      </FilterPanel>
      <Async state={state} what="Loading ranches">
        {() => (
          <>
            <RanchTable rows={rows.slice(offset, offset + PAGE)} />
            <Pagination total={rows.length} limit={PAGE} offset={offset} onChange={(o) => setQuery(route, { offset: o || null })} />
          </>
        )}
      </Async>
    </div>
  );
}

function RanchTable({ rows }: { rows: RanchSummary[] }) {
  return (
    <DataTable
      caption="Ranches"
      rows={rows}
      rowKey={(r) => r.ranch_id}
      onRow={(r) => navigate('ranches', r.ranch_id)}
      columns={[
        { key: 'id', header: 'Ranch', render: (r) => <a className="mono" href={href('ranches', r.ranch_id)}>{r.ranch_id}</a> },
        { key: 'name', header: 'Display name', render: (r) => r.display_name },
        { key: 'role', header: 'Role', render: (r) => r.role },
        { key: 'area', header: 'Area', align: 'right', render: (r) => ha(r.total_area_hectares, 0) },
        { key: 'pasture', header: 'Pasture', align: 'right', render: (r) => ha(r.pasture_area_hectares, 0) },
        { key: 'cap', header: 'Capacity (head)', align: 'right', render: (r) => num(r.estimated_cattle_capacity) },
        { key: 'defo', header: 'Post-cut-off clearing', align: 'right', render: (r) => ha(r.post_cutoff_deforestation_ha) },
        { key: 'env', header: 'Evidence', render: (r) => <EnvTag s={r.environmental_evidence} /> },
        { key: 'risk', header: 'Risk', render: (r) => <RiskBadge risk={r.risk_class} assessed={r.risk_status === 'assessed'} /> },
      ]}
    />
  );
}

function EnvTag({ s }: { s: RanchSummary['environmental_evidence'] }) {
  return s === 'available' ? <Tag tone="green">available</Tag> : s === 'missing' ? <Tag tone="amber">missing</Tag> : <Tag>outside window</Tag>;
}

function RanchPage({ id }: { id: string }) {
  return (
    <div className="page">
      <header className="page-head">
        <div className="crumbs">
          <a href={href('ranches')}>Ranches</a> / <span className="mono">{id}</span>
        </div>
        <h1 className="mono">{id}</h1>
      </header>
      <RanchDetailBody id={id} />
    </div>
  );
}

/** Ranch detail, used by the ranch page and the map drawer. */
export function RanchDetailBody({ id, compact }: { id: string; compact?: boolean }) {
  const state = useApi((s) => api.ranch(id, s), [id]);
  return (
    <Async state={state} what={`Loading ${id}`}>
      {({ data: d, meta }) => {
        const r = d.ranch;
        const inside = r.entity_type === 'ranch';
        return (
          <div className={compact ? 'stack' : 'grid-2 align-start'}>
            <div className="stack">
              <Section
                title="Registry"
                aside={
                  <span>
                    <ProvenanceLabel status={meta.data_status?.ranches || 'synthetic'}>record</ProvenanceLabel>{' '}
                    <RiskBadge risk={d.risk.risk_class} assessed={d.risk.risk_status === 'assessed'} />
                  </span>
                }
              >
                <KV
                  rows={[
                    ['Display name', r.display_name],
                    ['Type / role', `${r.entity_type} · ${r.role}`],
                    ['Municipality', r.municipality],
                    ['Area / pasture', `${ha(r.total_area_hectares, 0)} / ${ha(r.pasture_area_hectares, 0)}`],
                    ['Estimated capacity', r.estimated_cattle_capacity === null ? '—' : `${nf.format(r.estimated_cattle_capacity)} head (1.5 head/ha)`],
                    ['Opening herd (declared)', `${nf.format(r.opening_head)} head`],
                    ['Breeding cows (declared)', nf.format(r.breeding_cows_declared)],
                    ['Owner group', <span className="mono">{r.owner_group_id}</span>],
                    ['Data quality', `${r.data_quality.geometry} · ${r.data_quality.attributes}`],
                    ['Movements', Object.entries(d.movements).map(([k, v]) => `${label(k)} ${nf.format(v)}`).join(' · ') || '—'],
                    ['IsolationForest score', d.risk.anomaly_score === null ? '—' : `${num(d.risk.anomaly_score, 3)} (ranking, not a probability)`],
                  ]}
                />
                {inside && (
                  <a className="btn btn-small" href={href('map', null, { ranch: id, focus: id })}>
                    Open on Live Map
                  </a>
                )}
              </Section>
              <Section title="Environmental evidence">
                <EvidenceCard ev={d.environmental.evidence} status={d.environmental.status} />
              </Section>
            </div>
            <div className="stack">
              <Section title={`Findings (${d.risk.findings.length})`}>
                {d.risk.risk_status === 'not_assessed' ? (
                  <div className="note warn">The risk engine has not assessed this ranch. Not assessed is not clean.</div>
                ) : (
                  <FindingList findings={d.risk.findings} empty="Assessed: no finding on this ranch." />
                )}
              </Section>
              <RanchMovements id={id} />
            </div>
          </div>
        );
      }}
    </Async>
  );
}

function RanchMovements({ id }: { id: string }) {
  const [dir, setDir] = useState<'all' | 'in' | 'out'>('all');
  const [offset, setOffset] = useState(0);
  const state = useApi((s) => api.ranchMovements(id, { direction: dir, limit: 15, offset }, s), [id, dir, offset]);
  return (
    <Section
      title="Movements"
      aside={
        <select value={dir} onChange={(e) => (setDir(e.target.value as 'all'), setOffset(0))} aria-label="Direction">
          <option value="all">in and out</option>
          <option value="in">incoming</option>
          <option value="out">outgoing</option>
        </select>
      }
    >
      <Async state={state} what="Loading movements">
        {(p) => (
          <>
            <MovementTable rows={p.data} />
            <Pagination total={p.page.total} limit={p.page.limit} offset={p.page.offset} onChange={setOffset} />
          </>
        )}
      </Async>
    </Section>
  );
}

export function MovementTable({ rows }: { rows: MovementView[] }) {
  return (
    <DataTable
      rows={rows}
      rowKey={(m) => m.movement.gta_id}
      onRow={(m) => navigate('gtas', m.movement.gta_id)}
      columns={[
        { key: 'gta', header: 'GTA', render: (m) => <IdLink id={m.movement.gta_id} /> },
        { key: 'date', header: 'Date', render: (m) => m.movement.movement_date },
        { key: 'from', header: 'From', render: (m) => <IdLink id={m.movement.origin_id} /> },
        { key: 'to', header: 'To', render: (m) => <IdLink id={m.movement.destination_id} /> },
        { key: 'head', header: 'Head', align: 'right', render: (m) => nf.format(m.movement.head_count) },
        { key: 'status', header: 'Ledger', render: (m) => <LedgerTag m={m} /> },
      ]}
    />
  );
}

export function LedgerTag({ m }: { m: MovementView }) {
  if (m.ledger_status === 'accepted') return <Tag tone="green">accepted</Tag>;
  if (m.ledger_status === 'refused') return <Tag tone="red">refused · {m.refusal_reason}</Tag>;
  return <Tag tone="amber">not moved</Tag>;
}
