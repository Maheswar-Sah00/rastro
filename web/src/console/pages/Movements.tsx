import { useEffect, useMemo, useState } from 'react';
import { api } from '../api/client';
import type { BundleMovement } from '../api/types';
import { useApi } from '../api/useApi';
import { ProvenanceLabel, Tag } from '../components/Badges';
import { IdLink, KV, LineageView, Section } from '../components/Evidence';
import { DateFilter, FilterPanel, SelectFilter, TextFilter } from '../components/Filters';
import { Async } from '../components/States';
import { DataTable, Pagination } from '../components/Table';
import { loadLayer } from '../map/geo';
import { nf } from '../lib/format';
import { href, navigate, setQuery, type Route } from '../lib/router';
import { LedgerTag } from './Ranches';

const PAGE = 30;

export function Movements({ route }: { route: Route }) {
  const q = route.query;
  const f = {
    from: q.get('from') || '', to: q.get('to') || '', ranch: q.get('ranch') || '', susp: q.get('susp') || '',
    ledger: q.get('ledger') || '', emb: q.get('emb') || '', prov: q.get('prov') || '',
  };
  const offset = Number(q.get('offset') || 0);
  const state = useApi((s) => api.bundleMovements(s), []);
  const [embargoed, setEmbargoed] = useState<Set<string> | null>(null);
  useEffect(() => {
    loadLayer('ranch_evidence')
      .then((fc) => setEmbargoed(new Set(fc.features.filter((x) => x.properties?.embargo === 'active').map((x) => String(x.properties?.ranch_id)))))
      .catch(() => setEmbargoed(null));
  }, []);
  const rows = useMemo(() => {
    const all = (state.data?.data || []) as BundleMovement[];
    const R = f.ranch.toUpperCase();
    return all.filter(
      (m) =>
        (!f.from || m.date >= f.from) &&
        (!f.to || m.date <= f.to) &&
        (!R || m.from === R || m.to === R) &&
        (!f.susp || String(m.suspicious) === f.susp) &&
        (!f.ledger || (f.ledger === 'accepted' ? !m.rejected : m.rejected === f.ledger)) &&
        (!f.emb || !embargoed || (f.emb === 'yes') === embargoed.has(m.from)) &&
        (!f.prov || (f.prov === 'outside' ? m.from.startsWith('X') : !m.from.startsWith('X'))),
    );
  }, [state.data, f.from, f.to, f.ranch, f.susp, f.ledger, f.emb, f.prov, embargoed]);

  return (
    <div className="page">
      <header className="page-head">
        <h1>Movements</h1>
        <p className="muted">
          GTA permit records (synthetic). The list reads the published v1 movement bundle via <code>/api/v1/datasets/movements</code>; each row opens the
          canonical record and its lineage from <code>/api/v1/gtas/&#123;id&#125;</code>.
        </p>
      </header>
      <FilterPanel onReset={() => navigate('movements')}>
        <DateFilter label="From" value={f.from} onChange={(v) => setQuery(route, { from: v, offset: null })} />
        <DateFilter label="To" value={f.to} onChange={(v) => setQuery(route, { to: v, offset: null })} />
        <TextFilter label="Ranch (origin or destination)" value={f.ranch} onChange={(v) => setQuery(route, { ranch: v, offset: null })} placeholder="R0120" />
        <SelectFilter label="Suspicious (detector)" value={f.susp} onChange={(v) => setQuery(route, { susp: v, offset: null })}
          options={[{ value: 'true', label: 'suspicious' }, { value: 'false', label: 'not suspicious' }]} />
        <SelectFilter label="Ledger validation" value={f.ledger} onChange={(v) => setQuery(route, { ledger: v, offset: null })}
          options={[{ value: 'accepted', label: 'accepted' }, { value: 'InsufficientHerd', label: 'refused: insufficient herd' }, { value: 'OriginEmbargoed', label: 'refused: origin embargoed' }]} />
        <SelectFilter label="Origin embargo" value={f.emb} onChange={(v) => setQuery(route, { emb: v, offset: null })}
          options={[{ value: 'yes', label: 'origin under active embargo' }, { value: 'no', label: 'no active embargo' }]} />
        <SelectFilter label="Lineage completeness" value={f.prov} onChange={(v) => setQuery(route, { prov: v, offset: null })}
          options={[{ value: 'registered', label: 'origin registered (traceable)' }, { value: 'outside', label: 'origin outside window (incomplete)' }]} />
      </FilterPanel>
      <Async state={state} what="Loading movements">
        {(env) => (
          <>
            <div className="small muted">
              <ProvenanceLabel status={env.source === 'mock' ? 'unavailable' : 'synthetic'}>bundle</ProvenanceLabel> {env.schema}
              {env.source === 'mock' && ' · served from the MOCK bundle'}
              {f.emb && !embargoed && ' · embargo filter unavailable (map layer missing)'}
            </div>
            <DataTable
              rows={rows.slice(offset, offset + PAGE)}
              rowKey={(m) => m.gta}
              onRow={(m) => navigate('gtas', m.gta)}
              columns={[
                { key: 'gta', header: 'GTA', render: (m) => <a className="mono" href={href('gtas', m.gta)}>{m.gta}</a> },
                { key: 'date', header: 'Date', render: (m) => m.date },
                { key: 'from', header: 'Origin', render: (m) => <IdLink id={m.from} /> },
                { key: 'to', header: 'Destination', render: (m) => <IdLink id={m.to} /> },
                { key: 'head', header: 'Head', align: 'right', render: (m) => nf.format(m.head) },
                { key: 'purpose', header: 'Purpose', render: (m) => m.purpose },
                { key: 'v', header: 'Validation', render: (m) => (m.rejected ? <Tag tone="red">refused · {m.rejected}</Tag> : <Tag tone="green">accepted</Tag>) },
                { key: 's', header: 'Suspicious', render: (m) => (m.suspicious ? <Tag tone="amber">yes</Tag> : <span className="muted">no</span>) },
              ]}
            />
            <Pagination total={rows.length} limit={PAGE} offset={offset} onChange={(o) => setQuery(route, { offset: o || null })} />
          </>
        )}
      </Async>
    </div>
  );
}

export function GtaPage({ id }: { id: string }) {
  const state = useApi((s) => api.gta(id, s), [id]);
  return (
    <div className="page">
      <header className="page-head">
        <div className="crumbs">
          <a href={href('movements')}>Movements</a> / <span className="mono">{id}</span>
        </div>
        <h1 className="mono">{id}</h1>
      </header>
      <Async state={state} what={`Loading ${id}`}>
        {({ data: d }) => {
          const m = d.movement;
          return (
            <div className="stack">
              <Section title="Permit" aside={<LedgerTag m={d} />}>
                <KV
                  rows={[
                    ['Origin', <IdLink id={m.origin_id} />],
                    ['Destination', <IdLink id={m.destination_id} />],
                    ['Issue / movement date', `${m.issue_date} / ${m.movement_date}`],
                    ['Head', nf.format(m.head_count)],
                    ['Purpose', m.purpose],
                    ['Permit status', m.permit_status],
                    ['Declared lot', <IdLink id={m.lot_id} />],
                    ['Source lot ids', m.source_lot_ids === null ? 'not carried by GTAs (null)' : m.source_lot_ids.join(', ')],
                    ['Shipment', d.shipment_id ? <IdLink id={d.shipment_id} /> : '—'],
                    ['Provenance', m.provenance],
                  ]}
                />
              </Section>
              <Section title="Lineage of this lot" aside={<a href={href('lots', m.lot_id)}>Lot page (FIFO / pro-rata)</a>}>
                <LotLineageBlock lotId={m.lot_id} refused={d.ledger_status !== 'accepted'} />
              </Section>
            </div>
          );
        }}
      </Async>
    </div>
  );
}

function LotLineageBlock({ lotId, refused, policy = 'fifo' }: { lotId: string; refused?: boolean; policy?: 'fifo' | 'pro_rata' }) {
  const state = useApi((s) => api.lotLineage(lotId, policy, s), [lotId, policy]);
  if (refused) return <div className="note warn">This permit was not applied by the ledger rules, so it carries no traceable cattle. Its head is reported as unresolved in any shipment.</div>;
  return <Async state={state} what="Tracing lineage">{(t) => <LineageView t={t.data} />}</Async>;
}

export function LotPage({ id }: { id: string }) {
  const [policy, setPolicy] = useState<'fifo' | 'pro_rata'>('fifo');
  return (
    <div className="page">
      <header className="page-head">
        <div className="crumbs">
          <a href={href('movements')}>Movements</a> / <span className="mono">{id}</span>
        </div>
        <h1 className="mono">{id}</h1>
        <div className="seg" role="group" aria-label="Allocation policy">
          <button type="button" className={policy === 'fifo' ? 'on' : ''} onClick={() => setPolicy('fifo')} aria-pressed={policy === 'fifo'}>
            FIFO (default)
          </button>
          <button type="button" className={policy === 'pro_rata' ? 'on' : ''} onClick={() => setPolicy('pro_rata')} aria-pressed={policy === 'pro_rata'}>
            Pro-rata (mixed herd)
          </button>
        </div>
      </header>
      <Section title="Lineage">
        <LotLineageBlock lotId={id} policy={policy} />
      </Section>
    </div>
  );
}
