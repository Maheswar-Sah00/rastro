import { api } from '../api/client';
import { useApi } from '../api/useApi';
import { FilterPanel, SelectFilter, TextFilter } from '../components/Filters';
import { Async } from '../components/States';
import { Pagination } from '../components/Table';
import { ID_PATTERNS } from '../lib/ids';
import { navigate, setQuery, type Route } from '../lib/router';
import { Investigation } from './Investigation';
import { ShipTable } from './Overview';

const PAGE = 30;

export function Shipments({ route }: { route: Route }) {
  return route.id ? <Investigation id={route.id} /> : <ShipmentList route={route} />;
}

function ShipmentList({ route }: { route: Route }) {
  const q = route.query;
  const kind = q.get('kind') || '';
  const outcome = q.get('outcome') || '';
  const dest = q.get('dest') || '';
  const offset = Number(q.get('offset') || 0);
  const dests = useApi((s) => api.bundleDestinations(s), []);
  const state = useApi(
    (s) => api.shipments({ kind: kind || undefined, outcome: outcome || undefined, destination: dest || undefined, limit: PAGE, offset }, s),
    [kind, outcome, dest, offset],
  );
  return (
    <div className="page">
      <header className="page-head">
        <h1>Shipments</h1>
        <p className="muted">Every delivery to a slaughterhouse and every export ship, with Rastro's decision. Click one to investigate.</p>
      </header>
      <FilterPanel onReset={() => navigate('shipments')}>
        <TextFilter
          label="Go to shipment"
          value=""
          placeholder="SHP-D-001239"
          onChange={(v) => {
            const id = v.toUpperCase();
            if (ID_PATTERNS.shipment.test(id)) navigate('shipments', id);
          }}
        />
        <SelectFilter label="Kind" value={kind} onChange={(v) => setQuery(route, { kind: v, offset: null })}
          options={[{ value: 'delivery', label: 'delivery' }, { value: 'voyage', label: 'voyage' }]} />
        <SelectFilter label="Decision" value={outcome} onChange={(v) => setQuery(route, { outcome: v, offset: null })}
          options={['PASS', 'REVIEW', 'FLAGGED'].map((v) => ({ value: v, label: v }))} />
        <SelectFilter label="Destination" value={dest} onChange={(v) => setQuery(route, { dest: v, offset: null })}
          options={(dests.data?.data || []).map((d) => ({ value: d.id, label: `${d.id} · ${d.name}` }))} />
      </FilterPanel>
      <Async state={state} what="Loading shipments">
        {(p) => (
          <>
            <ShipTable rows={p.data} />
            <Pagination total={p.page.total} limit={p.page.limit} offset={p.page.offset} onChange={(o) => setQuery(route, { offset: o || null })} />
          </>
        )}
      </Async>
    </div>
  );
}
